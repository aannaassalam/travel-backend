import { Request, Response, Express } from "express";
import { sendEmail, azureSendMail } from "../utils/email_sms";
import { subCriptionExpireAlertHTML } from "../constants/constants";
import UserModel from "../model/userModel";
import AppError from "../utils/appError";
// import cron from "node-cron";

// Email retry configuration
const EMAIL_RETRY_CONFIG = {
    maxRetries: 3,
    retryDelay: 2000, // 2 seconds
    backoffMultiplier: 2 // Exponential backoff
};

// Batch processing configuration
const BATCH_CONFIG = {
    batchSize: 5, // Process 5 emails at a time (adjust based on email service limits)
    delayBetweenBatches: 1000, // 1 second delay between batches
    emailTimeout: 60000 // 60 second timeout per email
};

// Email processing statistics interface
interface EmailStats {
    totalProcessed: number;
    totalSent: number;
    totalFailed: number;
    successRate: number;
    processingTime: number;
}

// Helper function to send email with retry logic
const sendEmailWithRetry = async (
    emailData: { email: string; subject: string; html: string },
    maxRetries: number = EMAIL_RETRY_CONFIG.maxRetries
): Promise<{ success: boolean; email: string; attempts: number; error?: string }> => {
    let lastError: string = '';
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const isSent = await azureSendMail(emailData);
            
            if (isSent) {
                return { 
                    success: true, 
                    email: emailData.email, 
                    attempts: attempt 
                };
            } else {
                lastError = 'Email service returned false';
                
                // Wait before retry (exponential backoff)
                if (attempt < maxRetries) {
                    const delay = EMAIL_RETRY_CONFIG.retryDelay * Math.pow(EMAIL_RETRY_CONFIG.backoffMultiplier, attempt - 1);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        } catch (error) {
            lastError = error instanceof Error ? error.message : 'Unknown error';
            
            // Wait before retry (exponential backoff)
            if (attempt < maxRetries) {
                const delay = EMAIL_RETRY_CONFIG.retryDelay * Math.pow(EMAIL_RETRY_CONFIG.backoffMultiplier, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    return { 
        success: false, 
        email: emailData.email, 
        attempts: maxRetries,
        error: lastError 
    };
}

export const subscriptionExpireAlert = async (data: any[]): Promise<EmailStats> => {
    const startTime = Date.now();
    
    // Validate input data
    if (!Array.isArray(data)) {
        throw new AppError('Invalid input: data must be an array', 400);
    }
    
    // Early return if no data
    if (data.length === 0) {
        console.log('No users to send subscription expiry alerts to');
        return {
            totalProcessed: 0,
            totalSent: 0,
            totalFailed: 0,
            successRate: 0,
            processingTime: 0
        };
    }

    console.log(`Processing subscription expiry alerts for ${data.length} users`);

    try {
        // Split data into batches
        const batches = [];
        for (let i = 0; i < data.length; i += BATCH_CONFIG.batchSize) {
            batches.push(data.slice(i, i + BATCH_CONFIG.batchSize));
        }

        let totalSent = 0;
        let totalFailed = 0;

        // Process each batch
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            
            console.log(`Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} users)`);

            // Process all emails in current batch concurrently
            const batchPromises = batch.map(async (user: any) => {
                try {
                    // Validate user data
                    if (!user.email || !user.name || !user.subscriptionEndDate) {
                        console.warn(`Invalid user data: ${JSON.stringify(user)}`);
                        return { success: false, email: user.email || 'unknown', error: 'Invalid user data' };
                    }

                    const { email, name, subscriptionEndDate } = user;
                   
                    
                    // Change the date format ISO date month Year if currentFormat is ISO
                    let formattedSubscriptionEndDate: string;
                    let dateObj: Date;
                    
                    if (typeof subscriptionEndDate === 'string') {
                        // Convert string date to Date object if necessary
                        dateObj = new Date(subscriptionEndDate);
                        if (isNaN(dateObj.getTime())) {
                            console.warn(`Invalid subscription end date for ${email}: ${subscriptionEndDate}`);
                            return { success: false, email, error: 'Invalid subscription end date' };
                        }
                    } else if (subscriptionEndDate instanceof Date) {
                        dateObj = subscriptionEndDate;
                    } else {
                        console.warn(`Invalid subscription end date for ${email}: ${subscriptionEndDate}`);
                        return { success: false, email, error: 'Invalid subscription end date' };
                    }
                    
                    // Format date as "16th Sep 2025"
                    const day = dateObj.getDate();
                    const month = dateObj.toLocaleString('en-US', { month: 'short' });
                    const year = dateObj.getFullYear();
                    const dayWithSuffix = day + (day % 10 === 1 && day !== 11 ? 'st' : 
                                                 day % 10 === 2 && day !== 12 ? 'nd' : 
                                                 day % 10 === 3 && day !== 13 ? 'rd' : 'th');
                    formattedSubscriptionEndDate = `${dayWithSuffix} ${month} ${year}`;
                    // Generate HTML content
                    const htmlContent = subCriptionExpireAlertHTML(name, formattedSubscriptionEndDate);
                    
                    // Send email with timeout and retry logic
                    const emailResult = await Promise.race([
                        sendEmailWithRetry({
                            email,
                            subject: "Subscription Expiry Alert",
                            html: htmlContent,
                        }),
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new AppError('Email timeout', 408)), BATCH_CONFIG.emailTimeout)
                        )
                    ]) as { success: boolean; email: string; attempts: number; error?: string };

                    return emailResult;

                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    console.error(`Error processing email for ${user.email || 'unknown'}:`, errorMessage);
                    return { success: false, email: user.email || 'unknown', error: errorMessage, attempts: 0 };
                }
            });

            // Wait for all emails in the batch to complete
            const batchResults = await Promise.allSettled(batchPromises);
            
            // Process batch results
            batchResults.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    const { success, email, error, attempts } = result.value;
                    if (success) {
                        totalSent++;
                        console.log(`✓ Subscription expiry alert sent to ${email} (${attempts} attempts)`);
                    } else {
                        totalFailed++;
                        console.error(`✗ Failed to send alert to ${email}: ${error}`);
                    }
                } else {
                    totalFailed++;
                    const user = batch[index];
                    console.error(`✗ Promise rejected for ${user.email || 'unknown'}:`, result.reason);
                }
            });

            // Add delay between batches (except for the last batch)
            if (batchIndex < batches.length - 1) {
                console.log(`Waiting ${BATCH_CONFIG.delayBetweenBatches}ms before next batch...`);
                await new Promise(resolve => setTimeout(resolve, BATCH_CONFIG.delayBetweenBatches));
            }
        }

        // Calculate statistics
        const processingTime = Date.now() - startTime;
        const successRate = data.length > 0 ? (totalSent / data.length) * 100 : 0;
        
        const stats: EmailStats = {
            totalProcessed: data.length,
            totalSent,
            totalFailed,
            successRate: Math.round(successRate * 100) / 100, // Round to 2 decimal places
            processingTime
        };

        // Final summary
        console.log(`✅ Subscription expiry alert process completed:
        - Total processed: ${stats.totalProcessed}
        - Successfully sent: ${stats.totalSent}
        - Failed: ${stats.totalFailed}
        - Success rate: ${stats.successRate}%
        - Processing time: ${stats.processingTime}ms`);

        return stats;

    } catch (error) {
        console.error('Fatal error in subscriptionExpireAlert:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred during subscription expiry alert process';
        throw new AppError(errorMessage, 500); // Throw AppError instead of re-throwing original error
    }
};