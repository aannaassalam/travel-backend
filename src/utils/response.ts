import { Response } from "express";
import { headerSafe } from "./headerSafe";

/**
 * `X-Message` carries the human-readable outcome. It is a header, so Latin-1
 * only - see headerSafe for why that matters in a bilingual product whose copy
 * uses proper typography. `guardHeaders` protects this at the response level
 * too; sanitising here as well keeps the value predictable for anything that
 * reads it back.
 */
export const sendResponse = (
    res: Response,
    status: number,
    message: string,
    data?: any
) => {
    res.set("X-Message", headerSafe(message).slice(0, 400));
    res.status(status).json(data);
};
