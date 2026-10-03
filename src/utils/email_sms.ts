import msg91 from 'msg91'
import nodemailer from 'nodemailer'
import AppError from './appError'

interface EmailOptions {
   email: string
   subject: string
   html: string
   text?: string
   attachments?: nodemailer.SendMailOptions['attachments']
}

/**
 * Outgoing mail over SMTP — the mailbox's own outgoing server, nothing else.
 *
 * EMAIL_HOST / EMAIL_PORT are the "outgoing server" and "SMTP port" of the
 * mailbox; EMAIL_SECURE picks SSL/TLS (465) over STARTTLS (587) and is
 * inferred from the port when unset. The incoming server and IMAP port are
 * for reading mail and are deliberately not read: this API only sends.
 */
export const emailConfig = () => {
   const host = process.env.EMAIL_HOST
   const user = process.env.EMAIL_USERNAME
   const pass = process.env.EMAIL_PASSWORD
   if (!host || !user || !pass) return null
   const port = Number(process.env.EMAIL_PORT) || 587
   const secure =
      process.env.EMAIL_SECURE === undefined || process.env.EMAIL_SECURE === ''
         ? port === 465
         : process.env.EMAIL_SECURE === 'true'
   return {
      host,
      port,
      secure,
      user,
      pass,
      from: `"${process.env.EMAIL_FROM_NAME || 'Flexi Agency'}" <${process.env.EMAIL_FROM || user}>`,
   }
}

export const emailConfigured = () => emailConfig() !== null

// One pooled connection for the process, opened on first use.
let transporter: nodemailer.Transporter | null = null
const transport = () => {
   const cfg = emailConfig()
   if (!cfg) {
      throw new AppError(
         'Email is not configured: set EMAIL_HOST, EMAIL_PORT, EMAIL_USERNAME and EMAIL_PASSWORD',
         500
      )
   }
   transporter ??= nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      // On 587 insist on upgrading to TLS rather than ever sending the
      // password in the clear.
      requireTLS: !cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      pool: true,
   })
   return transporter
}

/** Connects and authenticates without sending — what `npm run email:test` calls first. */
export const verifyEmailTransport = () => transport().verify()

export const sendEmail = async (options: EmailOptions): Promise<void> => {
   const cfg = emailConfig()
   try {
      await transport().sendMail({
         from: cfg?.from,
         to: options.email,
         subject: options.subject,
         html: options.html,
         text: options.text,
         ...(options.attachments && { attachments: options.attachments }),
      })
   } catch (err: any) {
      if (err instanceof AppError) throw err
      // Name the usual culprit; the password itself never reaches a log.
      const hint =
         err.code === 'EAUTH'
            ? 'the mailbox refused the login — check EMAIL_USERNAME and EMAIL_PASSWORD'
            : err.code === 'ECONNECTION' || err.code === 'ETIMEDOUT' || err.code === 'ESOCKET'
              ? `could not reach ${cfg?.host}:${cfg?.port} — check EMAIL_HOST, EMAIL_PORT and EMAIL_SECURE`
              : err.message || String(err)
      console.error(`Email to ${options.email} failed: ${hint}`)
      throw new AppError(`Email could not be sent: ${hint}`, 500)
   }
}

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
