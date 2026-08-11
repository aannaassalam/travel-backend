import msg91 from 'msg91'
import nodemailer from 'nodemailer'
import twilio from 'twilio'
import catchAsync from './catchAsync'
import AppError from './appError'
import AzureEmailService from './azureEmailService'

interface EmailOptions {
   email: string
   subject: string
   html: string
   attachments?: any
}
interface SmsOptions {
   to: string
   body: string
}

// Azure email service instance
let azureEmailService: AzureEmailService | null = null;

// Initialize Azure email service if configuration is available
const initializeAzureEmailService = (): AzureEmailService | null => {
    if (azureEmailService) return azureEmailService;
    
    const connectionString = process.env.AZURE_COMMUNICATION_SERVICES_CONNECTION_STRING;
    const senderAddress = process.env.AZURE_SENDER_EMAIL;
    
    if (connectionString && senderAddress) {
        try {
            azureEmailService = new AzureEmailService();
            return azureEmailService;
        } catch (error) {
            console.error('Failed to initialize Azure email service:', error);
            return null;
        }
    }
    
    return null;
};

export const sendEmail = async (options: EmailOptions): Promise<void> => {
   // Try Azure email service first
   const azureService = initializeAzureEmailService();
   if (azureService) {
      try {
         const success = await azureService.sendEmail({
            to: options.email,
            subject: options.subject,
            htmlContent: options.html,
            ...(options.attachments && { attachments: options.attachments }),
         });
         if (success) {
            console.log('Email sent successfully via Azure Communication Services');
            return;
         }
      } catch (error) {
         console.warn('Azure email service failed, falling back to NodeMailer:', error);
      }
   }

   // Fallback to NodeMailer
   try {
      const transporter = nodemailer.createTransport({
         service: 'gmail',
         host: process.env.EMAIL_HOST as string,
         auth: {
            user: process.env.EMAIL_USERNAME,
            pass: process.env.EMAIL_PASSWORD,
         },
         pool: true,
         secure: false,
         logger: false,
      })

      const mailOptions: nodemailer.SendMailOptions = {
         from: `Health Consultant <${process.env.EMAIL_USERNAME}>`,
         to: options.email,
         subject: options.subject,
         html: options.html,
         ...(options.attachments && { attachments: options.attachments }),
      }

      await transporter.sendMail(mailOptions)
      console.log('Email sent successfully via NodeMailer');
   } catch (err: any) {
      console.log('NodeMailer Error:', err.message || err);
      
      // Handle specific Gmail authentication errors
      if (err.code === 'EAUTH') {
         console.error('Gmail Authentication Error: Please check your email credentials');
         console.error('Steps to fix Gmail authentication:');
         console.error('1. Enable 2-factor authentication on your Gmail account');
         console.error('2. Generate an App Password (not your regular password)');
         console.error('3. Use the App Password in EMAIL_PASSWORD environment variable');
         console.error('4. Make sure EMAIL_USERNAME is your full Gmail address');
      }
      
      throw new AppError('Failed to send email via both Azure and Gmail services', 500);
   }
}

// Azure-specific email function
export const azureSendMail = async (options: {
   email: string;
   subject: string;
   html: string;
   attachments?: Array<{
      name: string;
      contentType: string;
      contentInBase64: string;
   }>;
}): Promise<boolean> => {
   const azureService = initializeAzureEmailService();
   if (!azureService) {
      throw new Error('Azure Communication Services is not configured');
   }

   return await azureService.azureSendMail(options);
};

// Function to send SMS using Twilio
// export async function sendSMS(options: SmsOptions): Promise<any> {
//    try {
//       const client = twilio(
//          process.env.TWILIO_ACCOUNT_SID,
//          process.env.TWILIO_AUTH_TOKEN
//       )

//       await client.messages.create({
//          body: options.body,
//          to: options.to,
//          from: process.env.TWILIO_PHONE_NUMBER, // Your Twilio phone number
//       })

//       console.log('SMS sent successfully')
//    } catch (error) {
//       console.error('Error sending SMS:', error)
//       return new Error('Failed to send SMS')
//    }
// }



// Function to send SMS using msg91
msg91.initialize({ authKey: process.env.MSG91_AUTH_KEY });
// send otp through msg91 using templeId, mobile number 
// otp will be send in the {#var#} 
export const sendSMS = async (mobileNumber: string, templateId: string, otp?: string): Promise<any> => {
   try {
      if (!mobileNumber || !templateId) {
         return
      }
      // console.log("otp", otp)


      const sms = msg91.getSMS();
      sms.send(templateId, { 'mobile': `${+91}${mobileNumber}`, 'var': otp })
   } catch (error) {
      console.error('Error sending OTP:', error)
      return
   }
}

