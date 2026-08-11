import { Document, Query, FilterQuery } from "mongoose";

interface QueryString {
    [key: string]: string;
}

class APIFeatures<T extends Document> {
    query: Query<T[], T>;
    queryString: QueryString;
    totalCount: number = 0; // To store the total count of documents
    limit: number = 100; // Default limit

    constructor(query: Query<T[], T>, queryString: QueryString) {
        this.query = query;
        this.queryString = queryString as any;
    }

    async calculateTotalCount() {
        const countQuery = { ...this.query.getQuery() };
        this.totalCount = await this.query.model
            .countDocuments(countQuery)
            .exec();
        return this;
    }

    private isMongoOperatorObject(obj: any) {
        return (
            typeof obj === "object" &&
            obj !== null &&
            Object.keys(obj).every((key) => key.startsWith("$"))
        );
    }

    private convertTypes = (obj: any): any => {
        if (Array.isArray(obj)) {
            return obj.map(this.convertTypes);
        } else if (obj !== null && typeof obj === "object") {
            return Object.fromEntries(
                Object.entries(obj).map(([k, v]) => [k, this.convertTypes(v)])
            );
        } else if (typeof obj === "string") {
            if (obj.toLowerCase() === "true") return true;
            if (obj.toLowerCase() === "false") return false;
            if (!isNaN(Number(obj)) && obj.trim() !== "") return Number(obj);
            return obj;
        }
        return obj;
    };

    private flattenObject(
        obj: Record<string, any>,
        parentKey = "",
        result: Record<string, any> = {}
    ) {
        for (const key in obj) {
            const value = obj[key];
            const newKey = parentKey ? `${parentKey}.${key}` : key;

            if (
                value &&
                typeof value === "object" &&
                !Array.isArray(value) &&
                !this.isMongoOperatorObject(value)
            ) {
                this.flattenObject(value, newKey, result);
            } else {
                result[newKey] = value;
            }
        }

        return result;
    }

    private excludeFieldsAndParseQuery() {
        // Create a copy of the query string and exclude unwanted fields
        const queryObj = { ...this.queryString };
        const excludedFields = [
            "page",
            "sort",
            "limit",
            "fields",
            "search",
            "searchFields",
            "populate",
        ];
        excludedFields.forEach((el) => delete queryObj[el]);

        // Advanced filtering: handle operators like gte, gt, lte, lt
        let queryStr = JSON.stringify(queryObj);
        queryStr = queryStr.replace(
            /\b(gte|gt|lte|lt|in)\b/g,
            (match) => `$${match}`
        );

        const parsedQuery = JSON.parse(queryStr);

        const converted = this.convertTypes(parsedQuery);

        return this.flattenObject(converted); // Return the parsed query object
    }

    filter() {
        const filteredQuery = this.excludeFieldsAndParseQuery();
        console.log(filteredQuery);
        this.query = this.query.find(filteredQuery);
        return this;
    }
    sort() {
        // 2) Sorting
        if (this.queryString.sort) {
            const sortBy = this.queryString.sort.split(",").join(" ");
            this.query = this.query.sort(sortBy);
        } else {
            this.query = this.query.sort("-createdAt");
        }
        return this;
    }
    populate() {
        if (this.queryString.populate) {
            const populateFields = this.queryString.populate
                .split(",")
                .join(" ");
            // @ts-expect-error: type widening from populate()
            this.query = this.query.populate(populateFields);
        }
        return this;
    }
    search() {
        // Check if `search` query exists and if `searchFields` is present
        if (this.queryString.search && this.queryString.searchFields) {
            const searchValue = this.queryString.search as string;

            // Parse the `searchFields` correctly if it's a string that looks like an array (e.g., "[email,name]")
            let searchFields: string[];
            try {
                searchFields = JSON.parse(
                    this.queryString.searchFields as string
                );
            } catch (error) {
                // Fallback in case it's not a valid JSON string (e.g., "email,name")
                searchFields = (this.queryString.searchFields as string).split(
                    ","
                );
            }
            // Create regex for the search term
            const searchRegex = new RegExp(searchValue, "i"); // 'i' makes it case-insensitive

            // Construct $or array based on searchFields dynamically
            const searchCriteria = searchFields.map((field) => {
                return { [field.trim()]: searchRegex } as FilterQuery<T>;
            });
            const filteredQuery = this.excludeFieldsAndParseQuery();

            // Apply the search condition with proper casting to FilterQuery<T>
            this.query = this.query.find({
                $and: [filteredQuery, { $or: searchCriteria }],
            } as FilterQuery<T>);
        }

        return this;
    }
    limitFields() {
        // 3) Field limiting
        if (this.queryString.fields) {
            const fields = this.queryString.fields.split(",").join(" ");
            this.query = this.query.select(fields);
        } else {
            this.query = this.query.select("-__v");
        }
        return this;
    }

    paginate() {
        // 4) Pagination
        const page = parseInt(this.queryString.page, 10) || 1;
        this.limit = parseInt(this.queryString.limit, 10) || 100;
        const skip = (page - 1) * this.limit;

        this.query = this.query.skip(skip).limit(this.limit);

        return this;
    }
}

export default APIFeatures;
