import { EmailClient } from '@azure/communication-email';
import { EmailMessage } from '@azure/communication-email';

export interface EmailTemplate {
  subject: string;
  htmlContent: string;
  textContent?: string;
}

export interface EmailOptions {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  htmlContent?: string;
  textContent?: string;
  template?: EmailTemplate;
  attachments?: Array<{
    name: string;
    contentType: string;
    contentInBase64: string;
  }>;
}

class AzureEmailService {
  private emailClient: EmailClient;
  private senderAddress: string;
  private adminEmail: string;

  constructor() {
    const connectionString = process.env.AZURE_COMMUNICATION_SERVICES_CONNECTION_STRING;
    const senderAddress = process.env.AZURE_SENDER_EMAIL;
    const adminEmail = process.env.ADMIN_EMAIL;

    if (!connectionString) {
      throw new Error('AZURE_COMMUNICATION_SERVICES_CONNECTION_STRING environment variable is required');
    }
    if (!senderAddress) {
      throw new Error('AZURE_SENDER_EMAIL environment variable is required');
    }

    this.emailClient = new EmailClient(connectionString);
    this.senderAddress = senderAddress;
    this.adminEmail = adminEmail || 'admin@healthconsultant.com';
  }

  /**
   * Send email using Azure Communication Services
   * @param options Email options including recipients, subject, content, etc.
   * @returns Promise<boolean> - true if successful, false otherwise
   */
  async sendEmail(options: EmailOptions): Promise<boolean> {
    try {
      // Validate required fields
      if (!options.to) {
        throw new Error('At least one recipient email is required');
      }

      // Prepare recipients
      const toRecipients = Array.isArray(options.to) 
        ? options.to.map(email => ({ address: email }))
        : [{ address: options.to }];

      const ccRecipients = options.cc 
        ? Array.isArray(options.cc) 
          ? options.cc.map(email => ({ address: email }))
          : [{ address: options.cc }]
        : [];

      const bccRecipients = options.bcc 
        ? Array.isArray(options.bcc) 
          ? options.bcc.map(email => ({ address: email }))
          : [{ address: options.bcc }]
        : [];

      // Use template if provided, otherwise use direct content
      const subject = options.template?.subject || options.subject;
      const htmlContent = options.template?.htmlContent || options.htmlContent;
      const textContent = options.template?.textContent || options.textContent;

      // Prepare email message
      const emailMessage: EmailMessage = {
        senderAddress: this.senderAddress,
        content: {
          subject: subject,
          ...(htmlContent && { html: htmlContent }),
          ...(textContent && { plainText: textContent }),
        },
        recipients: {
          to: toRecipients,
          ...(ccRecipients.length > 0 && { cc: ccRecipients }),
          ...(bccRecipients.length > 0 && { bcc: bccRecipients }),
        },
        ...(options.attachments && options.attachments.length > 0 && {
          attachments: options.attachments
        }),
      };

      // Send email
      const poller = await this.emailClient.beginSend(emailMessage);
      const result = await poller.pollUntilDone();
      
      console.log('Email sent successfully via Azure:', result.id);
      return true;
    } catch (error: any) {
      // Handle specific Azure Communication Services errors
      if (error.code === 'DomainNotLinked') {
        console.error('Azure Email Error: Domain not linked. Please verify your domain in Azure Communication Services.');
        console.error('Steps to fix:');
        console.error('1. Go to Azure Portal > Communication Services > Your Resource > Domains');
        console.error('2. Verify your domain or use the default Azure domain');
        console.error('3. Update AZURE_SENDER_EMAIL with a verified domain email');
      } else if (error.code === 'Unauthorized') {
        console.error('Azure Email Error: Invalid connection string or access key');
      } else {
        console.error('Azure Email Error:', error.message || error);
      }
      return false;
    }
  }

  /**
   * Send email using Azure Communication Services (main function)
   * @param email Recipient email address
   * @param subject Email subject
   * @param html HTML content from constants or custom
   * @param attachments Optional attachments
   * @returns Promise<boolean>
   */
  async azureSendMail({
    email,
    subject,
    html,
    attachments = []
  }: {
    email: string;
    subject: string;
    html: string;
    attachments?: Array<{
      name: string;
      contentType: string;
      contentInBase64: string;
    }>;
  }): Promise<boolean> {
    try {
      return await this.sendEmail({
        to: email,
        subject: subject,
        htmlContent: html,
        attachments: attachments
      });
    } catch (error) {
      console.error('Error in azureSendMail:', error);
      return false;
    }
  }
}

export default AzureEmailService;
