import { Document, Schema } from "mongoose";

export interface ICustomerModel extends Document {
    email: string;
    photo?: string;
    name: string;
    phone?: string;
    countryCode?: string;
    addressLine1?: string;
    addressLine2?: string;
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    consultantType: 'internal' | 'external';
    comments?: string;
    internalConsultant?:Schema.Types.ObjectId;
    externalConsultant?:{
        name: string;
        email: string;
        phone?: string;
    }
    subscriptionStatus:'active' | 'inactive' | 'cancelled'| 'expired';
    subscriptionStartDate?: Date;
    subscriptionEndDate?: Date;
    
}