# Azure Communication Services Email Integration

This project integrates Azure Communication Services for email delivery with fallback to NodeMailer.

## Features

- **Azure Communication Services**: Primary email service with advanced features
- **NodeMailer Fallback**: Automatic fallback if Azure service is unavailable
- **Template Support**: Pre-built HTML email templates
- **Attachment Support**: Send emails with file attachments
- **Bulk Email**: Send emails to multiple recipients
- **CC/BCC Support**: Send emails with carbon copy and blind carbon copy
- **Notification Services**: Specialized functions for task and call notifications

## Configuration

Add the following environment variables to your `.env` file:

```env
# Azure Communication Services
AZURE_COMMUNICATION_SERVICES_CONNECTION_STRING=endpoint=https://your-resource.communication.azure.com/;accesskey=your-access-key
AZURE_SENDER_EMAIL=DoNotReply@your-verified-domain.azurecomm.net
ADMIN_EMAIL=admin@yourdomain.com

# NodeMailer Fallback (existing)
EMAIL_HOST=smtp.gmail.com
EMAIL_USERNAME=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
EMAIL_PORT=587
```

## Usage Examples

### 1. Basic Email Sending

```typescript
import { azureSendMail } from '../utils/email_sms';

// Send a simple email
const success = await azureSendMail({
    to: 'user@example.com',
    subject: 'Test Email',
    htmlContent: '<h1>Hello World!</h1><p>This is a test email.</p>',
});
```

### 2. Using Email Templates

```typescript
import { sendWelcomeEmail } from '../utils/emailTemplates';

// Send welcome email with template
const success = await sendWelcomeEmail('user@example.com', 'John Doe', 'consultant');
```

### 3. Sending Email with Attachments

```typescript
import { sendEmailWithAttachment } from '../utils/emailTemplates';

const success = await sendEmailWithAttachment(
    'user@example.com',
    'Your Report',
    '<h1>Report</h1><p>Please find your report attached.</p>',
    [
        {
            name: 'report.pdf',
            contentType: 'application/pdf',
            contentInBase64: 'base64-encoded-content-here',
        }
    ]
);
```

### 4. Sending Email with CC/BCC

```typescript
import { azureSendMail } from '../utils/email_sms';

const success = await azureSendMail({
    to: 'user@example.com',
    cc: ['manager@example.com'],
    bcc: ['admin@example.com'],
    subject: 'Important Update',
    htmlContent: '<p>This is an important update.</p>',
});
```

### 5. Task Notification

```typescript
import { sendClientNotification } from '../utils/email_sms';

const success = await sendClientNotification({
    clientEmails: ['client1@example.com', 'client2@example.com'],
    taskDetails: {
        dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // Due tomorrow
        taskNote: 'Please complete the health assessment form',
    },
    senderName: 'Dr. Smith',
    customSubject: 'Urgent: Health Assessment Due Tomorrow',
});
```

### 6. Call Notification

```typescript
import { sendCallNotification } from '../utils/email_sms';

const success = await sendCallNotification({
    recipientEmails: ['client@example.com'],
    callDetails: {
        callDate: new Date(Date.now() + 2 * 60 * 60 * 1000), // In 2 hours
        callTime: '2:00 PM',
        callNote: 'Discussion about your health plan',
    },
    senderName: 'Dr. Smith',
});
```

### 7. Bulk Email

```typescript
import { sendBulkEmail } from '../utils/emailTemplates';

const recipients = ['user1@example.com', 'user2@example.com', 'user3@example.com'];
const success = await sendBulkEmail(
    recipients,
    'Monthly Newsletter',
    '<h1>Newsletter</h1><p>This is our monthly newsletter.</p>',
    50 // batch size
);
```

## Available Email Templates

1. **PASSWORD_HTML**: System generated password email
2. **OTP_RESET_HTML**: Password reset OTP email
3. **WELCOME_EMAIL_HTML**: Welcome email for new users
4. **ACCOUNT_CREATED_HTML**: Account creation confirmation
5. **contactUsHTML**: Contact form submission email

## Template Functions

- `sendPasswordEmail(email, name, password)`: Send password email
- `sendOTPEmail(email, name, otp)`: Send OTP email
- `sendWelcomeEmail(email, name, role)`: Send welcome email
- `sendAccountCreatedEmail(email, name, userEmail, tempPassword?)`: Send account created email
- `sendContactUsEmail(adminEmail, name, email, phone?, companyName?, message?)`: Send contact form email

## Error Handling

The service includes automatic fallback to NodeMailer if Azure Communication Services fails:

```typescript
export const sendEmail = async (options: EmailOptions): Promise<void> => {
   // Try Azure email service first
   const azureService = initializeAzureEmailService();
   if (azureService) {
      try {
         const success = await azureService.sendEmail(options);
         if (success) {
            console.log('Email sent successfully via Azure Communication Services');
            return;
         }
      } catch (error) {
         console.warn('Azure email service failed, falling back to NodeMailer:', error);
      }
   }

   // Fallback to NodeMailer
   // ... NodeMailer implementation
};
```

## Integration in Controllers

The service is already integrated in the `authController.ts`:

```typescript
// Send welcome email after signup
try {
    await sendEmail({
        email,
        subject: 'Welcome to Health Consultant!',
        html: WELCOME_EMAIL_HTML(name, assignedRole),
    });
} catch (err) {
    console.warn('Failed to send welcome email:', err);
}

// Send OTP email for password reset
await sendEmail({
    email: user.email,
    subject: 'Your password reset OTP (valid for 10 min)',
    html: OTP_RESET_HTML(user.name, resetOtp),
});
```

## Testing

To test the email service, you can use the example functions:

```typescript
import { exampleUsage } from '../utils/emailTemplates';

// Test simple email
await exampleUsage.sendSimpleEmail();

// Test template email
await exampleUsage.sendTemplateEmail();

// Test task notification
await exampleUsage.sendTaskNotification();
```

## Security Notes

- Never commit your Azure connection string to version control
- Use environment variables for all sensitive configuration
- Validate email addresses before sending
- Implement rate limiting for bulk operations
- Monitor email delivery status and failures

## Troubleshooting

1. **Azure Service Not Working**: Check connection string and sender email configuration
2. **NodeMailer Fallback Issues**: Verify SMTP credentials and settings
3. **Email Not Delivered**: Check spam folders and email validation
4. **Rate Limiting**: Implement delays between bulk email batches
5. **Template Errors**: Verify template function parameters and HTML content

## Dependencies

- `@azure/communication-email`: Azure Communication Services SDK
- `nodemailer`: NodeMailer for fallback email service
- Custom email templates from `constants/constants.ts`
