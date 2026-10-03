/**
 * Proves the SMTP settings in .env work: connects, authenticates, sends one
 * message. Usage: npm run email:test -- you@example.com (defaults to the
 * mailbox itself).
 */
import 'dotenv/config'
import { emailConfig, sendEmail, verifyEmailTransport } from '../utils/email_sms'

async function main() {
   const cfg = emailConfig()
   if (!cfg) {
      console.error('Email is not configured: set EMAIL_HOST, EMAIL_PORT, EMAIL_USERNAME and EMAIL_PASSWORD in .env')
      process.exit(1)
   }
   const to = process.argv[2] || cfg.user
   console.log(`SMTP ${cfg.host}:${cfg.port} (${cfg.secure ? 'SSL/TLS' : 'STARTTLS'}) as ${cfg.user}`)
   await verifyEmailTransport()
   console.log('Connected and authenticated.')
   await sendEmail({
      email: to,
      subject: 'Flexi Agency — test email',
      html: `<p>This is a test message from the Flexi Agency API, sent ${new Date().toISOString()}.</p>`,
   })
   console.log(`Sent to ${to}. Check the inbox (and spam).`)
   process.exit(0)
}

main().catch((e) => {
   console.error('Failed:', e.message || e)
   process.exit(1)
})
