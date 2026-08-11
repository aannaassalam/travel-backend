import { Request, Response, NextFunction } from "express";
import catchAsync from "./../utils/catchAsync";
import AppError from "./../utils/appError";
import APIFeatures from "./../utils/apiFeatures";
import { Model, Document, Query } from "mongoose";
import { sendEmail } from "../utils/email_sms";
import { contactUsHTML } from "../constants/constants";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { Parser } from "json2csv";
import dayjs from "dayjs";
import { sendResponse } from "../utils/response";
import qs from "qs";
import { QueryValue } from "../constants/interfaces";

interface Message {
    message?: string;
}

interface CreateOptions extends Message {
    afterCreate?: (doc: any) => Promise<void> | void;
}

interface GetAllOptions extends Message {
    role?: string;
}

export const deleteOne = (Model: Model<Document>, options?: Message) =>
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        const doc = await Model.findByIdAndDelete(req.params.id);

        if (!doc) {
            return next(
                new AppError(`No ${Model.modelName} found with that ID`, 404)
            );
        }

        sendResponse(
            res,
            200,
            options?.message ?? `${Model.modelName} deleted successfully`,
            null
        );
    });

export const updateOne = (Model: Model<Document>, options?: Message) =>
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        const doc = await Model.findByIdAndUpdate(req.params.id, req.body, {
            new: true,
            runValidators: true,
        });
        if (!doc) {
            return next(
                new AppError(`No ${Model.modelName} found with that ID`, 404)
            );
        }
        doc.save({ validateBeforeSave: false });
        sendResponse(
            res,
            200,
            options?.message ?? `${Model.modelName} updated successfully`,
            doc
        );
    });

export const createOne = (Model: Model<Document>, options?: CreateOptions) =>
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        const doc = await Model.create(req.body);

        // Execute afterCreate callback if provided
        if (options?.afterCreate) {
            await options.afterCreate(doc);
        }

        sendResponse(
            res,
            201,
            options?.message ?? `${Model.modelName} created successfully`,
            doc
        );
    });

export const getOne = (Model: Model<Document>, options?: Message) =>
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        const populateFields = req.query.populate
            ? (req.query.populate as any)?.split(",").join(" ")
            : "";
        let query: Query<Document | null, Document> = Model.findById(
            req.params.id
        ).populate(populateFields); // Explicitly specify the type of query

        const doc = await query.exec(); // Execute the query

        if (!doc) {
            return next(
                new AppError(`No ${Model.modelName} found with that ID`, 404)
            );
        }

        sendResponse(
            res,
            200,
            options?.message ?? `${Model.modelName} retrieved successfully`,
            doc
        );
    });

export const getAll = (Model: Model<Document>, options?: GetAllOptions) =>
    catchAsync(async (req: Request, res: Response, next: NextFunction) => {
        let filter = {};
        if (options?.role) filter = { role: options.role };
        const features = new APIFeatures(Model.find(filter), req.query as any)
            .filter()
            .sort()
            .limitFields()
            .paginate()
            .search()
            .populate();
        await features.calculateTotalCount();
        const doc = await features.query;

        const totalPages = Math.ceil(features.totalCount / features.limit);
        const currentPage = parseInt(req.query.page as string, 10) || 1;

        const responseData = {
            data: doc,
            meta: {
                results: doc.length,
                limit: features.limit,
                currentPage,
                totalPages,
                totalCount: features.totalCount,
            },
        };

        sendResponse(
            res,
            200,
            options?.message ?? `${Model.modelName} retrieved successfully`,
            responseData
        );
    });

export const sendContactUsMail = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { name, email, phone, companyName, message } = req.body;
        if (!name || !email || !message) {
            return next(
                new AppError("Please provide all required fields", 400)
            );
        }
        await sendEmail({
            email: "support@taxcenter.co.in",
            subject: "Contact Us",
            html: contactUsHTML(name, email, phone, companyName, message),
        });
        sendResponse(res, 200, "Mail sent successfully", null);
    }
);

export const downloadReport = async (
    Model: any, // Model to query transactions from
    condition: any, // Condition to apply to the query
    format: string, // The format of the report (csv or pdf)
    fields: any[], // Fields to include in the report
    heading: string = "Report"
) => {
    try {
        const foundTx = await Model.find(condition); // Query the model with the passed condition
        // Configure the parser with the updated fields
        const json2csvParser = new Parser({ fields });
        let csvContent = json2csvParser.parse(foundTx); // Generate CSV

        // If the format is PDF, convert the CSV to PDF
        if (format === "pdf") {
            csvContent = await convertCsvToPdf(csvContent, `${heading}`);
        }

        return csvContent; // Return the generated CSV or PDF content
    } catch (error) {
        // Handle any errors during report generation
        return new AppError(
            "Error generating transaction report: " + error.message,
            401
        );
    }
};

// (pdfMake as any).vfs = pdfFonts.pdfMake.vfs;

// export const convertCsvToPdf = (csvContent: string): Promise<Buffer> => {
//     return new Promise((resolve, reject) => {
//         const data: any[] = [];

//         // Create a readable stream from the CSV content string
//         const csvStream = Readable.from(csvContent);

//         // Parse the CSV content using the csv-parser module
//         csvStream
//             .pipe(csvParser()) // Corrected usage
//             .on('data', (row) => {
//                 data.push(row);
//             })
//             .on('end', () => {
//                 try {
//                     const docDefinition = {
//                         content: [
//                             {
//                                 table: {
//                                     headerRows: 1,
//                                     widths: Array(Object.keys(data[0]).length).fill('*'),
//                                     body: [
//                                         Object.keys(data[0]).map((key) => key),
//                                         ...data.map((row) => Object.values(row)),
//                                     ],
//                                 },
//                             },
//                         ],
//                     };

//                     const pdfDoc = pdfMake.createPdf(docDefinition);

//                     pdfDoc.getBuffer((pdfBytes: Uint8Array) => {
//                         const pdfBuffer = Buffer.from(pdfBytes);
//                         resolve(pdfBuffer);
//                     });
//                 } catch (error) {
//                     reject(new Error(`Error generating PDF: ${error.message}`));
//                 }
//             })
//             .on('error', (error) => {
//                 reject(new Error(`Error processing CSV: ${error.message}`));
//             });
//     });
// };
export const convertCsvToPdf = async (
    csvContent,
    heading: string = "Report"
) => {
    try {
        const pdfDoc = await PDFDocument.create();
        const pageSize: [number, number] = [841.89, 595.28]; // A4 size in points (width, height)
        const fontSize = 12;
        const headingFontSize = 18;
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

        const createNewPage = () => {
            const page = pdfDoc.addPage(pageSize);
            const { width, height } = page.getSize();
            page.drawText(heading, {
                x: 10,
                y: height - headingFontSize - 10,
                size: headingFontSize,
                font: boldFont,
            });
            return page;
        };

        let page = createNewPage();
        const { width, height } = page.getSize();

        const lines = csvContent.split("\n");
        const cellPadding = 5;
        const cellHeight = fontSize + cellPadding * 2;
        let yPosition = height - cellHeight - headingFontSize - 20;

        const table = lines.map((line) => line.split(","));

        // Calculate the column widths
        const colWidths = [];
        table[0].forEach((_, colIndex) => {
            const maxColWidth = Math.max(
                ...table.map((row) => row[colIndex].length)
            );
            colWidths.push(maxColWidth * fontSize * 0.6 + cellPadding * 2); // estimate width based on character count
        });

        // Draw table
        for (const row of table) {
            if (yPosition < cellHeight) {
                // Add a new page if the current page is full
                page = createNewPage();
                yPosition = height - cellHeight - headingFontSize - 20;
            }

            let xPosition = 10;
            row.forEach((cell, colIndex) => {
                const cellWidth = colWidths[colIndex];

                // Draw cell border
                page.drawRectangle({
                    x: xPosition,
                    y: yPosition,
                    width: cellWidth,
                    height: cellHeight,
                    borderColor: rgb(0, 0, 0),
                    borderWidth: 1,
                });

                // Draw cell text
                page.drawText(cell, {
                    x: xPosition + cellPadding,
                    y: yPosition + cellPadding,
                    size: fontSize,
                    font: font,
                });

                xPosition += cellWidth;
            });
            yPosition -= cellHeight;
        }

        const pdfBytes = await pdfDoc.save();
        return Buffer.from(pdfBytes);
    } catch (error) {
        throw new AppError(
            "Error generating transaction report: " + error.message,
            401
        );
    }
};
export const formatDateTime = (date: Date) => {
    return dayjs(date).format("YYYY-MM-DD hh:mma").toLowerCase();
};
