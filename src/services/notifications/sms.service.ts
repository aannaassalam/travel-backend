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
         (process.env.TWILIO_PHONE_NUMBER ||
            process.env.TWILIO_MESSAGING_SERVICE_SID ||
            process.env.TWILIO_ALPHA_SENDER)
   )

/**
 * Alphanumeric Sender ID — the message shows as "FlexiAgency" instead of a
 * +1 number.
 *
 * Twilio caps this at 11 characters, so "Flexi Agency" with its space does not
 * fit; "FlexiAgency" is exactly 11. Anything longer is rejected by the API at
 * send time, which is a failed OTP rather than a warning, so it is trimmed and
 * checked here instead.
 *
 * Two things this costs, both unavoidable and neither a bug:
 *   - It is ONE-WAY. A customer cannot reply, and a reply is silently lost.
 *     Keep TWILIO_PHONE_NUMBER set for anything expecting an answer.
 *   - Support is per-country and several require pre-registration. Where it is
 *     unsupported Twilio does not fall back — it errors — so the number stays
 *     the configured sender and this is opt-in.
 */
const alphaSender = () => {
   const raw = (process.env.TWILIO_ALPHA_SENDER || '').trim()
   if (!raw) return null
   if (raw.length > 11) {
      console.warn(
         `TWILIO_ALPHA_SENDER "${raw}" is ${raw.length} characters; Twilio allows 11. Ignoring it.`
      )
      return null
   }
   return raw
}

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
   /**
    * Messaging Service first: Twilio then picks the sender and handles
    * per-country compliance itself, which is what makes +243 traffic reliable —
    * and an Alphanumeric Sender ID can be attached to the service in the
    * console, so this branch already covers the branded name properly.
    *
    * The explicit alpha sender is for accounts not using a Messaging Service.
    */
   const alpha = TWILIO_MESSAGING_SERVICE_SID ? null : alphaSender()
   const primary = TWILIO_MESSAGING_SERVICE_SID
      ? { messagingServiceSid: TWILIO_MESSAGING_SERVICE_SID }
      : alpha
        ? { from: alpha }
        : { from: TWILIO_PHONE_NUMBER! }

   let message
   try {
      message = await client.messages.create({ to, body, ...primary })
   } catch (err) {
      /**
       * Alphanumeric sender IDs are per-country, and Twilio does NOT quietly
       * fall back where they are not permitted — it rejects the message. Left
       * alone that turns a branded name into a failed OTP, so a rejection is
       * retried once with the plain number.
       *
       * ONLY on a rejection: `err.status` in the 4xx range means Twilio looked
       * at the request and refused it, so nothing was sent and nothing was
       * billed. A timeout or a 5xx might have been accepted before the
       * connection broke, and retrying those could send and charge twice.
       */
      const rejected =
         typeof (err as any)?.status === 'number' &&
         (err as any).status >= 400 &&
         (err as any).status < 500

      if (!alpha || !TWILIO_PHONE_NUMBER || !rejected) throw err

      console.warn(
         `Alphanumeric sender "${alpha}" was refused for ${to} ` +
            `(Twilio ${(err as any).code ?? (err as any).status}). Retrying from the number.`
      )
      message = await client.messages.create({ to, body, from: TWILIO_PHONE_NUMBER })
   }

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
