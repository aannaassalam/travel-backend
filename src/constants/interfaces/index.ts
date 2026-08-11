export { IUserDocument } from "./IUser";
export { ICustomerModel } from "./ICustomerModel";

export interface RequestWithParsedPage extends Request {
    page: number;
    limit: number;
}

export type QueryValue =
    | string
    | string[]
    | number
    | boolean
    | { [key: string]: any };
