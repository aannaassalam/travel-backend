import { PASSWORD_POLICY } from '../constants/admin.constants'

/**
 * §1.3: minimum length only (PASSWORD_POLICY.MIN_LENGTH). The
 * breached-password check (HaveIBeenPwned) was removed at the owner's request.
 */

/** Returns an error message, or null when the password is acceptable. */
export const validateAdminPassword = async (
   password: string
): Promise<string | null> => {
   if (typeof password !== 'string' || password.length < PASSWORD_POLICY.MIN_LENGTH) {
      return `Password must be at least ${PASSWORD_POLICY.MIN_LENGTH} characters`
   }
   return null
}
