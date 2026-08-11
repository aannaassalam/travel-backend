import crypto from 'crypto'

/**
 * §14.5: passport and ID data encrypted at rest **with a separate key**.
 *
 * AES-256-GCM. The IV and auth tag travel with the ciphertext, so rotating the
 * key later only needs a re-encrypt pass, not a schema change. GCM (not CBC)
 * because it authenticates — a tampered ciphertext fails to decrypt rather than
 * silently returning garbage.
 *
 * The key is deliberately NOT the JWT secret and not the database password:
 * "encrypted at rest with a separate key" is the whole point, otherwise a
 * single leaked secret unlocks both the tokens and the passport numbers.
 */

const PREFIX = 'enc:v1:'

const key = (): Buffer | null => {
   const raw = process.env.PII_ENCRYPTION_KEY
   if (!raw) return null
   const buf = Buffer.from(raw, 'hex')
   if (buf.length !== 32) {
      throw new Error(
         'PII_ENCRYPTION_KEY must be 32 bytes hex-encoded (64 hex characters)'
      )
   }
   return buf
}

export const isEncrypted = (value?: string) =>
   Boolean(value?.startsWith(PREFIX))

export const encryptField = (plain?: string): string | undefined => {
   if (!plain) return plain
   if (isEncrypted(plain)) return plain
   const k = key()
   /**
    * Fail open in development so the panel still runs before the key is
    * provisioned — but never silently in production, where unencrypted passport
    * data at rest is exactly what §14.5 exists to prevent.
    */
   if (!k) {
      if (process.env.NODE_ENV === 'production') {
         throw new Error('PII_ENCRYPTION_KEY is required in production')
      }
      return plain
   }
   const iv = crypto.randomBytes(12)
   const cipher = crypto.createCipheriv('aes-256-gcm', k, iv)
   const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
   const tag = cipher.getAuthTag()
   return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
}

export const decryptField = (stored?: string): string | undefined => {
   if (!stored) return stored
   if (!isEncrypted(stored)) return stored // written before the key existed
   const k = key()
   if (!k) return undefined
   try {
      const [, , ivB64, tagB64, dataB64] = stored.split(':')
      const decipher = crypto.createDecipheriv(
         'aes-256-gcm',
         k,
         Buffer.from(ivB64, 'base64')
      )
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
      return Buffer.concat([
         decipher.update(Buffer.from(dataB64, 'base64')),
         decipher.final(),
      ]).toString('utf8')
   } catch {
      // Wrong key or tampered payload — never return partial plaintext.
      return undefined
   }
}
