import { Request, Response, NextFunction } from "express";
import UserModel from "../model/userModel";
import Customer from "../model/customerModel";
import catchAsync from "../utils/catchAsync";
import { sendResponse } from "../utils/response";
import AppError from "../utils/appError";
import {subscriptionExpireAlert} from "../services/automatedMail";
interface Data {
    email: string;
    name: string;
    subscriptionEndDate: Date;
    customerId?: string; // Optional, if customer is associated
}

export const sendRenewSubscriptionAlert = catchAsync(async (req: Request, res: Response, next: NextFunction) => {   
    const {data}: {data: Data[]} = req.body;
    if (!data || data.length === 0) {
        return next(new AppError('No data provided for subscription renewal alert', 400));
    }   

    const emailStats =  subscriptionExpireAlert(data);
    sendResponse(res, 200, 'Subscription renewal alert sent successfully', {
        emailStats,
    });
});

export const adminDashboard = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const currentDate = new Date();
    
    // Execute all database queries in parallel using Promise.all for better performance
    const [customerStats, consultantStats, userStats] = await Promise.all([

        // Single aggregation pipeline for all customer statistics
        Customer.aggregate([
            {
                $facet: {
                    totalCustomers: [{ $count: "count" }],
                    activeCustomers: [
                        { $match: { subscriptionEndDate: { $gt: currentDate } } },
                        { $count: "count" }
                    ],
                    expiredCustomers: [
                        { $match: { subscriptionEndDate: { $lt: currentDate } } },
                        { $count: "count" }
                    ]
                }
            }
        ]),
        
        // Single aggregation pipeline for all consultant statistics
        UserModel.aggregate([
            {
                $match: { role: "consultant" }
            },
            {
                $facet: {
                    totalConsultants: [{ $count: "count" }],
                    activeConsultants: [
                        { $match: { active:true } },
                        { $count: "count" }
                    ]
                }
            }
        ]),
        
        // Total users count
        UserModel.countDocuments()
    ]);
    
    // Extract results with fallback values
    const customerData = customerStats[0];
    const consultantData = consultantStats[0];
    
    const dashboardData = {
        totalUsers: userStats,
        totalCustomers: customerData.totalCustomers[0]?.count || 0,
        activeCustomers: customerData.activeCustomers[0]?.count || 0,
        subscriptionExpiredCustomers: customerData.expiredCustomers[0]?.count || 0,
        totalConsultants: consultantData.totalConsultants[0]?.count || 0,
        activeConsultants: consultantData.activeConsultants[0]?.count || 0
    };
    
    sendResponse(res, 200, 'Dashboard data retrieved successfully', dashboardData);
});


export const consultantDashboard = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const {_id:userId} = req.user;
    
    // fetch consultant details whose internalConsultant matches the logged-in user
    const customerStats = await Customer.aggregate([
        {
            $match: { internalConsultant: userId }
        },
        {
            $facet: {
                totalCustomers: [{ $count: "count" }],
                activeCustomers: [
                    { $match: { subscriptionEndDate: { $gte: new Date() } } },
                    { $count: "count" }
                ],
                expiredCustomers: [
                    { $match: { subscriptionEndDate: { $lt: new Date() } } },
                    { $count: "count" }
                ]
            }
        }   
    ])

    sendResponse(res, 200, 'Consultant dashboard data retrieved successfully', {
        totalCustomers: customerStats[0]?.totalCustomers[0]?.count || 0,
        activeCustomers: customerStats[0]?.activeCustomers[0]?.count || 0,
        subscriptionExpiredCustomers: customerStats[0]?.expiredCustomers[0]?.count || 0
    });
});