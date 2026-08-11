# Email Service Troubleshooting Guide

## Issue 1: Azure Communication Services - Domain Not Linked

### Error Message:
```
RestError: The specified sender domain has not been linked.
Code: "DomainNotLinked"
```

### Solution Steps:

#### Option A: Use Azure Managed Domain (Recommended for testing)
1. Go to [Azure Portal](https://portal.azure.com)
2. Navigate to your Communication Services resource
3. Go to **Domains** section in the left menu
4. You'll see a pre-configured domain like: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.azurecomm.net`
5. Update your `.env` file:
   ```env
   AZURE_SENDER_EMAIL=DoNotReply@xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.azurecomm.net
   ```

#### Option B: Add Custom Domain (For production)
1. Go to **Domains** section in Azure Communication Services
2. Click **Add domain**
3. Enter your domain name (e.g., `yourdomain.com`)
4. Follow DNS verification steps:
   - Add TXT record to your domain's DNS
   - Add MX record for email routing
   - Wait for verification (can take up to 48 hours)
5. Once verified, update your `.env` file:
   ```env
   AZURE_SENDER_EMAIL=noreply@yourdomain.com
   ```

---

## Issue 2: Gmail Authentication Error

### Error Message:
```
Error: Invalid login: 535-5.7.8 Username and Password not accepted
Code: 'EAUTH'
```

### Solution Steps:

#### Step 1: Enable 2-Factor Authentication
1. Go to your [Google Account settings](https://myaccount.google.com/)
2. Navigate to **Security**
3. Enable **2-Step Verification**

#### Step 2: Generate App Password
1. In Google Account settings, go to **Security**
2. Under **2-Step Verification**, click **App passwords**
3. Select **Mail** as the app
4. Select **Other** as the device and name it "Health Consultant Server"
5. Copy the generated 16-character password

#### Step 3: Update Environment Variables
```env
EMAIL_USERNAME=your-email@gmail.com
EMAIL_PASSWORD=your-16-character-app-password
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
```

#### Alternative: Use OAuth2 (More Secure)
If you prefer OAuth2 instead of app passwords, update your NodeMailer config:

```javascript
const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    type: 'OAuth2',
    user: process.env.EMAIL_USERNAME,
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
  },
});
```

---

## Complete Environment Variables

### Required for Azure Email Service:
```env
# Azure Communication Services
AZURE_COMMUNICATION_SERVICES_CONNECTION_STRING=endpoint=https://your-resource.communication.azure.com/;accesskey=your-key
AZURE_SENDER_EMAIL=DoNotReply@your-domain.azurecomm.net
ADMIN_EMAIL=admin@yourdomain.com
```

### Required for Gmail Fallback:
```env
# Gmail Configuration
EMAIL_HOST=smtp.gmail.com
EMAIL_USERNAME=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
EMAIL_PORT=587
```

---

## Testing Your Email Service

Create a test script to verify both services:

```javascript
// test-email.js
const { sendEmail } = require('./src/utils/email_sms');

async function testEmail() {
    try {
        await sendEmail({
            email: 'test@example.com',
            subject: 'Test Email',
            html: '<h1>Test</h1><p>This is a test email.</p>'
        });
        console.log('✅ Email sent successfully!');
    } catch (error) {
        console.error('❌ Email failed:', error.message);
    }
}

testEmail();
```

Run the test:
```bash
node test-email.js
```

---

## Common Issues and Solutions

### 1. Connection String Format
❌ **Wrong:**
```
AZURE_COMMUNICATION_SERVICES_CONNECTION_STRING=https://your-resource.communication.azure.com/
```

✅ **Correct:**
```
AZURE_COMMUNICATION_SERVICES_CONNECTION_STRING=endpoint=https://your-resource.communication.azure.com/;accesskey=your-access-key
```

### 2. Sender Email Format
❌ **Wrong:**
```
AZURE_SENDER_EMAIL=noreply@gmail.com
```

✅ **Correct:**
```
AZURE_SENDER_EMAIL=DoNotReply@your-verified-domain.azurecomm.net
```

### 3. Gmail App Password
- Must be exactly 16 characters
- No spaces or special characters
- Generated from Google Account > Security > App passwords

### 4. Domain Verification Status
Check domain status in Azure portal:
- ✅ **Verified**: Ready to use
- ⏳ **Pending**: Wait for DNS propagation
- ❌ **Failed**: Check DNS records

---

## Priority Fix Order

1. **First**: Fix Azure domain linking (easier)
2. **Second**: Fix Gmail authentication (fallback)
3. **Test**: Both services independently

This ensures you have at least one working email service while troubleshooting the other.
