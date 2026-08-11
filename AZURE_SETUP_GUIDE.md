# Azure Communication Services Setup Guide

## Required Environment Variables

### 1. AZURE_COMMUNICATION_SERVICES_CONNECTION_STRING
```
AZURE_COMMUNICATION_SERVICES_CONNECTION_STRING=endpoint=https://your-resource-name.communication.azure.com/;accesskey=your-access-key-here
```

**How to get this:**
1. Go to Azure Portal (portal.azure.com)
2. Create or navigate to your Communication Services resource
3. Go to "Keys" section in the left menu
4. Copy the "Connection string" value

### 2. AZURE_SENDER_EMAIL
```
AZURE_SENDER_EMAIL=DoNotReply@your-verified-domain.azurecomm.net
```

**How to get this:**
1. In your Communication Services resource, go to "Domains" section
2. Add and verify your domain OR use the default Azure domain
3. The sender email must be from a verified domain
4. Format: `anything@your-domain.azurecomm.net`

### 3. ADMIN_EMAIL
```
ADMIN_EMAIL=admin@yourdomain.com
```

**This is your application's admin email address for receiving notifications**

## Azure Portal Setup Steps

### Step 1: Create Communication Services Resource
1. Go to Azure Portal
2. Search for "Communication Services"
3. Click "Create"
4. Fill in:
   - Subscription: Your Azure subscription
   - Resource Group: Create new or use existing
   - Resource Name: e.g., "health-consultant-email"
   - Data Location: Choose your preferred region
5. Click "Review + Create"

### Step 2: Configure Email Domain
1. In your Communication Services resource, go to "Domains"
2. Option A: Use Azure Managed Domain (easier)
   - Use the provided domain: `xxxx.azurecomm.net`
   - Sender email: `DoNotReply@xxxx.azurecomm.net`
3. Option B: Add Custom Domain (more professional)
   - Click "Add domain"
   - Enter your domain name
   - Follow DNS verification steps
   - Wait for verification (can take up to 48 hours)

### Step 3: Get Connection String
1. Go to "Keys" section in left menu
2. Copy the "Connection string" value
3. Add to your `.env` file

## Testing Your Setup

Create a test file to verify your Azure email service:

```javascript
// test-azure-email.js
const AzureEmailService = require('./src/utils/azureEmailService').default;

async function testEmail() {
    try {
        const emailService = new AzureEmailService();
        
        const success = await emailService.azureSendMail({
            email: 'test@example.com',
            subject: 'Test Email from Azure',
            html: '<h1>Test Email</h1><p>This is a test email from Azure Communication Services.</p>'
        });
        
        console.log('Email sent successfully:', success);
    } catch (error) {
        console.error('Error:', error);
    }
}

testEmail();
```

## Common Issues

### 1. Connection String Error
- **Error**: "AZURE_COMMUNICATION_SERVICES_CONNECTION_STRING environment variable is required"
- **Solution**: Make sure the connection string is correctly set in your `.env` file

### 2. Sender Email Error
- **Error**: "AZURE_SENDER_EMAIL environment variable is required"
- **Solution**: Set the sender email from your verified domain

### 3. Domain Not Verified
- **Error**: Email sending fails with domain verification error
- **Solution**: Ensure your domain is verified in Azure portal

### 4. Rate Limiting
- **Error**: Too many requests
- **Solution**: Azure has rate limits. Implement delays between bulk emails

## Pricing Information

Azure Communication Services Email pricing (as of 2025):
- First 25,000 emails per month: Free
- Additional emails: $0.0012 per email
- No setup fees or monthly minimums

## Security Best Practices

1. **Never commit connection strings to version control**
2. **Use environment variables for all sensitive data**
3. **Rotate access keys regularly**
4. **Monitor email usage and set up alerts**
5. **Use least privilege access principles**

## Fallback Configuration

The system automatically falls back to NodeMailer if Azure fails:

```env
# NodeMailer Fallback (Gmail example)
EMAIL_HOST=smtp.gmail.com
EMAIL_USERNAME=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
EMAIL_PORT=587
```

For Gmail, you'll need to:
1. Enable 2-factor authentication
2. Generate an "App Password"
3. Use the app password instead of your regular password
