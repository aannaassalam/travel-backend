import crypto from 'crypto'
import { PASSWORD_POLICY } from '../constants/admin.constants'

/**
 * §1.3: minimum 14 characters, checked against a breached-password list.
 *
 * Uses the HaveIBeenPwned range API, which is k-anonymous — only the first five
 * characters of the SHA-1 hash leave this process, so the password itself is
 * never transmitted. No dependency and no local wordlist to keep current.
 */
export const isBreached = async (password: string): Promise<boolean> => {
   const sha1 = crypto
      .createHash('sha1')
      .update(password)
      .digest('hex')
      .toUpperCase()
   const prefix = sha1.slice(0, 5)
   const suffix = sha1.slice(5)

   try {
      const res = await fetch(
         `https://api.pwnedpasswords.com/range/${prefix}`,
         { signal: AbortSignal.timeout(3000) }
      )
      if (!res.ok) return false
      const body = await res.text()
      return body
         .split('\n')
         .some((line) => line.split(':')[0].trim() === suffix)
   } catch {
      // Fail open: the owner must not be locked out of setting a password
      // because an external service is unreachable. Length rules still apply.
      return false
   }
}

/** Returns an error message, or null when the password is acceptable. */
export const validateAdminPassword = async (
   password: string
): Promise<string | null> => {
   if (!password || password.length < PASSWORD_POLICY.MIN_LENGTH) {
      return `Password must be at least ${PASSWORD_POLICY.MIN_LENGTH} characters`
   }
   if (await isBreached(password)) {
      return 'This password appears in a known breach. Choose a different one.'
   }
   return null
}
