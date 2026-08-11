import { IUserDocument } from "../constants/interfaces";

declare global {
    namespace Express {
        interface Request {
            user?: IUserDocument;
        }
    }
}
