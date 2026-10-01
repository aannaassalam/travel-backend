/**
 * Admin realm constants. Deliberately separate from constants.ts — nothing in
 * the public realm should import from here (guide §2.1).
 */

/**
 * The KIND of an admin account (§1.1). SUPER_ADMIN and BREAK_GLASS implicitly
 * hold every permission. STAFF holds exactly the permissions of its one
 * assigned AccessRole document, and nothing at all without one.
 */
export const ADMIN_ROLES = {
   SUPER_ADMIN: 'SUPER_ADMIN',
   BREAK_GLASS: 'BREAK_GLASS',
   STAFF: 'STAFF',
} as const

export type AdminRole = (typeof ADMIN_ROLES)[keyof typeof ADMIN_ROLES]

/**
 * The permission catalogue. These are the only valid permission strings: the
 * route table, the role editor and the guard all read this one list.
 *
 * A write permission does NOT imply the matching read; each is checked alone.
 */
export const PERMISSIONS = [
   'dashboard:read',
   'orders:read',
   'orders:write',
   'enquiries:read',
   'enquiries:write',
   'inventory:read',
   'inventory:write',
   'customers:read',
   'customers:write',
   'customers:export',
   'payments:read',
   'content:read',
   'content:write',
   'notifications:read',
   'notifications:write',
   'settings:read',
   'settings:write',
   'security:read',
   'audit:read',
   'users:read',
   'users:write',
   'roles:read',
   'roles:write',
] as const

export type Permission = (typeof PERMISSIONS)[number]

/** Token audience. A customer token must be structurally unable to reach /admin/v1 (§1.3). */
export const ADMIN_TOKEN_AUDIENCE = 'admin'

const hours = (h: number) => h * 60 * 60 * 1000

/**
 * Session lifetimes.
 *
 * The guide (§1.3) specifies an 8-hour maximum with a 30-minute idle timeout.
 * The client asked for 7 days to stop the administrator being logged out during
 * normal work — so that is the default here, tunable per environment without a
 * deploy.
 *
 * Both clocks matter: the absolute one caps how long a stolen token stays
 * useful, the idle one is what actually causes a mid-day logout. Raising only
 * one of them changes nothing the user would notice.
 *
 * The trade-off, recorded once: with 2FA removed the password is the only
 * factor, and the token cookie is readable by JavaScript, so a 7-day window is
 * 7 days of usefulness for a stolen token rather than 8 hours. Sessions remain
 * revocable from the Security screen, and a password change still invalidates
 * every existing token immediately.
 */
export const SESSION_POLICY = {
   /** Absolute session lifetime. ADMIN_SESSION_HOURS overrides. */
   MAX_AGE_MS: hours(Number(process.env.ADMIN_SESSION_HOURS) || 24 * 7),
   /** Idle timeout. ADMIN_IDLE_TIMEOUT_HOURS overrides. */
   IDLE_TIMEOUT_MS: hours(Number(process.env.ADMIN_IDLE_TIMEOUT_HOURS) || 24 * 7),
   /**
    * Step-up re-auth window. Deliberately NOT lengthened: this is not a logout,
    * it is the prompt before exports, FX changes, payment exceptions and
    * passport unmasking. Stretching it would mean a walked-away-from laptop
    * could export the customer database.
    */
   STEP_UP_WINDOW_MS: 5 * 60 * 1000,
}

export const PASSWORD_POLICY = {
   /**
    * §1.3: minimum 14 characters.
    *
    * The guide also mandates TOTP 2FA; the client has decided against it, so
    * the password is the only authentication factor in this system. That makes
    * this length floor and the breach check the last application-layer control
    * standing, and §14.1's network isolation load-bearing rather than
    * defence-in-depth.
    */
   MIN_LENGTH: 14,
   /**
    * How long a system-generated temporary password can be used to sign in.
    * It sits in a mailbox or a chat message until then, so it must not stay
    * valid forever; an expired one is simply reset again from the Users screen.
    */
   TEMP_PASSWORD_TTL_MS: 72 * 60 * 60 * 1000,
}

export const LOCKOUT_POLICY = {
   /** Failed attempts before delays begin (§1.3, progressive delay). */
   THRESHOLD: 3,
   BASE_DELAY_MS: 30 * 1000,
   MAX_DELAY_MS: 60 * 60 * 1000,
}

/**
 * Actions that must appear in the audit log. Mutations are logged wholesale by
 * the service layer; the sensitive *reads* here are logged explicitly (§2.2).
 */
export const AUDIT_ACTIONS = {
   LOGIN_SUCCESS: 'LOGIN_SUCCESS',
   LOGIN_FAILED: 'LOGIN_FAILED',
   LOGOUT: 'LOGOUT',
   BREAK_GLASS_ENABLED: 'BREAK_GLASS_ENABLED',
   STEP_UP_SUCCESS: 'STEP_UP_SUCCESS',
   STEP_UP_FAILED: 'STEP_UP_FAILED',
   SESSIONS_REVOKED: 'SESSIONS_REVOKED',
   PASSWORD_CHANGED: 'PASSWORD_CHANGED',
   /** Any change to who can do what: admin users, their roles, role permissions. */
   ADMIN_ACCESS_CHANGED: 'ADMIN_ACCESS_CHANGED',
   CREATE: 'CREATE',
   UPDATE: 'UPDATE',
   DELETE: 'DELETE',
   /** Sensitive reads (§2.2) — logged even though nothing changed. */
   PASSPORT_UNMASKED: 'PASSPORT_UNMASKED',
   CUSTOMER_EXPORTED: 'CUSTOMER_EXPORTED',
   FINANCIAL_EXPORTED: 'FINANCIAL_EXPORTED',
} as const

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]

/**
 * Events that must reach the owner on a channel not reachable from the admin
 * panel (§14.2), so an attacker inside the panel cannot suppress them.
 */
export const OUT_OF_BAND_ALERTS: AuditAction[] = [
   AUDIT_ACTIONS.BREAK_GLASS_ENABLED,
   AUDIT_ACTIONS.CUSTOMER_EXPORTED,
   AUDIT_ACTIONS.FINANCIAL_EXPORTED,
   AUDIT_ACTIONS.PASSWORD_CHANGED,
   AUDIT_ACTIONS.ADMIN_ACCESS_CHANGED,
]
