import twilio from 'twilio'
import AppError from '../../utils/appError'

/**
 * The one place this system talks to an SMS provider.
 *
 * Both the sign-in code and the customer notifications go through here, so
 * there is a single set of credentials, one place to change provider, and one
 * definition of what "sent" means. Two call sites drift; one does not.
 */

export interface SmsResult {
   sid: string
   status: string
   /** Provider-reported price in minor units, when it gives one. */
   costMinor?: number
}

export const smsConfigured = () =>
   Boolean(
      process.env.TWILIO_ACCOUNT_SID &&
         process.env.TWILIO_AUTH_TOKEN &&
         (process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_MESSAGING_SERVICE_SID)
   )

/**
 * Sends, or throws. It never resolves for a message that did not leave the
 * building — a silent success is how a customer ends up waiting for a code
 * that was never sent, and how the office believes a booking was confirmed to
 * someone who heard nothing.
 *
 * A Messaging Service SID is preferred when set: Twilio then handles sender
 * selection and per-country compliance, which matters for +243 traffic.
 */
export const sendSms = async (to: string, body: string): Promise<SmsResult> => {
   const {
      TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN,
      TWILIO_PHONE_NUMBER,
      TWILIO_MESSAGING_SERVICE_SID,
   } = process.env

   if (!smsConfigured()) {
      throw new AppError('SMS delivery is not configured', 503, 'SMS_NOT_CONFIGURED')
   }

   const client = twilio(TWILIO_ACCOUNT_SID!, TWILIO_AUTH_TOKEN!)
   const from = TWILIO_MESSAGING_SERVICE_SID
      ? { messagingServiceSid: TWILIO_MESSAGING_SERVICE_SID }
      : { from: TWILIO_PHONE_NUMBER! }

   const message = await client.messages.create({ to, body, ...from })

   return {
      sid: message.sid,
      status: message.status,
      // Twilio reports price as a negative decimal string ("-0.0075"), and only
      // once the message has actually been rated — usually after this returns.
      costMinor: message.price
         ? Math.round(Math.abs(parseFloat(message.price)) * 100)
         : undefined,
   }
}
