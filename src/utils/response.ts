import { Response } from "express";

export const sendResponse = (
    res: Response,
    status: number,
    message: string,
    data?: any
) => {
    res.set("X-Message", message);
    res.status(status).json(data);
};
