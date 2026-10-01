import fs from 'fs'
import { App, cert, getApps, initializeApp } from 'firebase-admin/app'
import { getMessaging } from 'firebase-admin/messaging'

import { ACTIVE_DEVICE_MS, DeviceToken } from '../../model/deviceTokenModel'

/**
 * Push notifications to the customer app, through Firebase Cloud Messaging.
 *
 * Credentials are the Firebase service-account key, given one of two ways:
 *   FIREBASE_SERVICE_ACCOUNT_JSON  the key itself (raw JSON or base64) — for a
 *                                  server, where it comes from the host's
 *                                  secret store and no file has to be shipped;
 *   FIREBASE_SERVICE_ACCOUNT_FILE  a path to the key file — for a laptop.
 * With neither, push is simply "not configured": every notification falls back
 * to SMS, exactly as before push existed.
 */

/**
 * The key from the environment, or null.
 *
 * Either variable may hold any of the three forms — raw JSON, base64, or a
 * path — because the two are easy to mix up and the result of guessing wrong
 * used to be Node quoting the "file name" (the entire key) in its error.
 */
const serviceAccount = (): Record<string, any> | null => {
   const value = (
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT_FILE
   )?.trim()
   if (!value) return null
   if (value.startsWith('{')) return JSON.parse(value)
   // existsSync never throws, even on a "path" thousands of characters long.
   if (fs.existsSync(value)) return JSON.parse(fs.readFileSync(value, 'utf8'))
   return JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
}

let app: App | null | undefined

const firebase = (): App | null => {
   if (app !== undefined) return app
   try {
      const account = serviceAccount()
      app = account ? (getApps()[0] ?? initializeApp({ credential: cert(account) })) : null
   } catch (err) {
      /**
       * The error's NAME only. Its message can quote the value it choked on —
       * a JSON parse error echoes the text, a file error echoes the "path" —
       * and here that value is the private key.
       */
      console.error(
         `[push] service-account key could not be loaded (${(err as Error).name}). ` +
            'Check FIREBASE_SERVICE_ACCOUNT_JSON / FIREBASE_SERVICE_ACCOUNT_FILE.'
      )
      app = null
   }
   return app
}

export const pushConfigured = () => Boolean(firebase())

/** The customer's app installs seen recently enough to count. */
export const activeDevices = (customerId: unknown) =>
   DeviceToken.find({
      customer: customerId,
      lastSeenAt: { $gt: new Date(Date.now() - ACTIVE_DEVICE_MS) },
   }).lean()

/**
 * FCM answers that mean the install is gone for good.
 *
 * `invalid-argument` is NOT one of them on its own: Firebase returns it for
 * any rejected request, an oversized message included, and treating that as a
 * dead token would delete every healthy install the message was sent to. It
 * counts only when the error is about the token itself.
 */
const isDeadToken = (error?: { code?: string; message?: string }) =>
   error?.code === 'messaging/registration-token-not-registered' ||
   error?.code === 'messaging/invalid-registration-token' ||
   (error?.code === 'messaging/invalid-argument' &&
      /registration token/i.test(error.message ?? ''))

export interface PushResult {
   delivered: number
   failed: number
   error?: string
}

/**
 * Sends one notification to every given install. `data` rides along for the
 * app to act on when tapped (which screen to open); values must be strings.
 */
export const sendPush = async (
   tokens: string[],
   message: { title: string; body: string; data: Record<string, string> }
): Promise<PushResult> => {
   const fb = firebase()
   if (!fb || !tokens.length) return { delivered: 0, failed: tokens.length, error: 'not configured' }

   const res = await getMessaging(fb).sendEachForMulticast({
      tokens,
      notification: { title: message.title, body: message.body },
      data: message.data,
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
   })

   // Forget installs FCM says are gone, so they stop counting as "has the app".
   const dead = res.responses
      .map((r, i) => (!r.success && isDeadToken(r.error) ? tokens[i] : null))
      .filter((t): t is string => Boolean(t))
   if (dead.length) await DeviceToken.deleteMany({ token: { $in: dead } })

   const firstError = res.responses.find((r) => !r.success)?.error
   return {
      delivered: res.successCount,
      failed: res.failureCount,
      error: firstError ? `${firstError.code}: ${firstError.message}`.slice(0, 300) : undefined,
   }
}
