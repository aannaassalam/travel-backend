/**
 * Self-check for admin access control — the part of the system where a missing
 * line is not a bug but an open door.
 *
 *   npm run check:rbac
 *
 * It reads the real /admin/v1 route table and proves that:
 *   a. every route behind protectAdmin names a permission from the catalogue;
 *   b. every mutation under /users and /roles also needs step-up;
 *   c. the only routes with no permission guard are the /auth/* self-service
 *      routes and the signed-file download;
 *   d. the pure rule functions decide the way the rules say they do.
 *
 * No framework, no database and no server: it imports the router, never
 * connects, and never sends a request. It prints the whole surface so a person
 * can read who-needs-what on one screen.
 */
import assert from 'assert'

import { ADMIN_ROLES, PERMISSIONS } from '../constants/admin.constants'
import {
   Actor,
   canGrant,
   kindRefusal,
   losesActiveSuper,
   parseRoleInput,
   roleEditRefusal,
   targetRefusal,
} from '../controllers/admin/accessController'
import {
   isSubset,
   permissionsFor,
   protectAdmin,
   requirePasswordChanged,
   requirePermission,
   requireStepUp,
} from '../middleware/adminAuth'
import adminRouter from '../routes/admin/v1'
import authRouter from '../routes/admin/v1/authRouter'

let failures = 0
const check = (name: string, fn: () => void) => {
   try {
      fn()
      console.log(`  ✓ ${name}`)
   } catch (err: any) {
      failures += 1
      console.error(`  ✗ ${name}\n      ${err.message}`)
   }
}

// ---------------------------------------------------------------------------
// Walk the route table
// ---------------------------------------------------------------------------

interface Row {
   method: string
   path: string
   /** Position in the router, to check ordering. */
   index: number
   behindAuth: boolean
   permission?: string
   /** The permission guard is the first handler, so nothing runs before it. */
   guardFirst: boolean
   stepUp: boolean
}

const catalogue: readonly string[] = PERMISSIONS
const problems: string[] = []

/** Every route of one router, plus anything in it that is not a route. */
const walk = (router: any, prefix: string, known: unknown[]) => {
   const rows: Row[] = []
   let behindAuth = false

   // A router.param handler runs before any route's own guard, unseen here.
   if (Object.keys(router.params ?? {}).length) {
      problems.push(`${prefix || '/'}: router.param handlers run before the permission guard and are not checked`)
   }

   router.stack.forEach((layer: any, index: number) => {
      if (layer.handle === protectAdmin) {
         behindAuth = true
         return
      }
      if (known.includes(layer.handle)) return
      if (!layer.route) {
         // A nested router or a stray middleware could hide anything.
         problems.push(
            `${prefix || '/'}: unrecognised middleware "${layer.name}" at position ${index}`
         )
         return
      }

      // router.route(path).get(guard, h).post(h2) shares one stack between
      // methods, so a guard on one would look like a guard on both.
      if (Object.keys(layer.route.methods).length !== 1) {
         problems.push(
            `${prefix}${layer.route.path}: several methods on one router.route() — declare each on its own line so its guard can be checked`
         )
         return
      }

      const handles: any[] = layer.route.stack.map((l: any) => l.handle)
      const guardAt = handles.findIndex((h) => h.permission !== undefined)
      const stepUpAt = handles.indexOf(requireStepUp)

      Object.keys(layer.route.methods).forEach((method) => {
         rows.push({
            method: method.replace('_all', 'all').toUpperCase(),
            path: prefix + layer.route.path,
            index,
            behindAuth,
            permission: handles[guardAt]?.permission,
            guardFirst: guardAt === 0,
            // Step-up only counts when it runs after the permission guard.
            stepUp: stepUpAt > guardAt,
         })
      })
   })
   return rows
}

const stack: any[] = (adminRouter as any).stack
const business = walk(adminRouter, '', [authRouter, requirePasswordChanged])
const auth = walk(authRouter, '/auth', [])

const label = (r: Row) => `${r.method} ${r.path}`

console.log('\nAdmin access control (RBAC) self-check\n')

console.log('Route table: /admin/v1\n')
const width = Math.max(...[...auth, ...business].map((r) => label(r).length))
;[...auth, ...business].forEach((r) => {
   const needs = r.permission
      ? `${r.permission}${r.stepUp ? ' + step-up' : ''}`
      : r.path.startsWith('/auth/')
        ? r.behindAuth
           ? '(signed in — self-service)'
           : '(public — sign in)'
        : '(no session — signed link)'
   console.log(`  ${label(r).padEnd(width)}  ->  ${needs}`)
})

// ---------------------------------------------------------------------------
// a–c: the route table
// ---------------------------------------------------------------------------

console.log('\nRoute guards')

check('the router is put together in the expected order', () => {
   assert.deepStrictEqual(problems, [], problems.join('; '))
   const at = stack.findIndex((l) => l.handle === protectAdmin)
   assert.ok(at >= 0, 'protectAdmin is not mounted on the admin router')
   assert.strictEqual(
      stack.filter((l) => l.handle === protectAdmin).length,
      1,
      'protectAdmin should be mounted exactly once'
   )
   assert.strictEqual(
      stack[at + 1]?.handle,
      requirePasswordChanged,
      'the forced-password-change gate must come immediately after protectAdmin'
   )
   assert.ok(
      stack.findIndex((l) => l.handle === authRouter) < at,
      '/auth must be mounted before protectAdmin so PATCH /auth/password stays reachable'
   )
})

check('(a) every route behind protectAdmin names a catalogue permission', () => {
   const bad = business
      .filter((r) => r.behindAuth)
      .filter((r) => !r.guardFirst || !catalogue.includes(r.permission as string))
      .map((r) => `${label(r)} [${r.permission ?? 'no guard'}]`)
   assert.deepStrictEqual(bad, [], `unguarded or unknown permission: ${bad.join(', ')}`)
   assert.ok(business.some((r) => r.behindAuth), 'no protected routes found at all')
})

check('(b) every mutation under /users and /roles needs step-up', () => {
   const access = business.filter((r) => /^\/(users|roles)(\/|$)/.test(r.path))
   const bad = access.filter((r) => r.method !== 'GET' && !r.stepUp).map(label)
   assert.deepStrictEqual(bad, [], `no step-up on: ${bad.join(', ')}`)
   assert.ok(access.length > 0, 'no /users or /roles routes found')
})

check('(c) only /auth/* and the signed file link have no permission guard', () => {
   const open = business.filter((r) => !r.behindAuth).map(label)
   assert.deepStrictEqual(open, ['GET /files/:key'], `outside protectAdmin: ${open}`)

   // Pinned on purpose: a new /auth route has no permission guard, so adding
   // one should be a decision somebody makes here, not a side effect.
   assert.deepStrictEqual(
      auth.map((r) => `${label(r)}${r.behindAuth ? '' : ' (public)'}`),
      [
         'POST /auth/login (public)',
         'GET /auth/me',
         'POST /auth/logout',
         'POST /auth/step-up',
         'PATCH /auth/password',
         'GET /auth/sessions',
         'DELETE /auth/sessions/others',
      ],
      'the /auth self-service routes changed'
   )
})

check('the users and roles routes match the contract', () => {
   const actual = business
      .filter((r) => /^\/(users|roles)(\/|$)/.test(r.path))
      .map((r) => `${label(r)} -> ${r.permission}${r.stepUp ? ' + step-up' : ''}`)
   assert.deepStrictEqual(actual, [
      'GET /roles -> roles:read',
      'POST /roles -> roles:write + step-up',
      'PATCH /roles/:id -> roles:write + step-up',
      'DELETE /roles/:id -> roles:write + step-up',
      'GET /users -> users:read',
      'GET /users/assignable-roles -> users:write',
      'POST /users -> users:write + step-up',
      'PATCH /users/:id -> users:write + step-up',
      'POST /users/:id/reset-password -> users:write + step-up',
   ])
   // Same order as registration, so assignable-roles is ahead of /users/:id.
})

// ---------------------------------------------------------------------------
// d: the guards and the rule functions
// ---------------------------------------------------------------------------

console.log('\nGuards')

/** Runs a middleware against a fake request and returns what it passed to next. */
const outcome = (middleware: any, req: Record<string, any>) => {
   let result: any = 'next was never called'
   middleware(req, {}, (err?: any) => {
      result = err
   })
   return result
}

check('requirePermission passes only when the permission is held', () => {
   const guard = requirePermission('orders:read')
   assert.strictEqual(guard.permission, 'orders:read')

   const admin = { role: ADMIN_ROLES.STAFF }
   const held = { admin, adminAccess: { permissions: ['orders:read'] } }
   assert.strictEqual(outcome(guard, held), undefined, 'a held permission was refused')

   // Write does not imply read.
   const writeOnly = { admin, adminAccess: { permissions: ['orders:write'] } }
   assert.strictEqual(outcome(guard, writeOnly)?.statusCode, 403)
   assert.strictEqual(outcome(guard, { admin, adminAccess: { permissions: [] } })?.statusCode, 403)
   // Nothing resolved means nothing held — even for a super admin object.
   assert.strictEqual(outcome(guard, { admin: { role: ADMIN_ROLES.SUPER_ADMIN } })?.statusCode, 403)
   assert.strictEqual(outcome(guard, {})?.statusCode, 401)
})

check('requirePasswordChanged blocks a temporary password', () => {
   const blocked = outcome(requirePasswordChanged, { admin: { mustChangePassword: true } })
   assert.strictEqual(blocked?.statusCode, 403)
   assert.strictEqual(blocked?.code, 'PASSWORD_CHANGE_REQUIRED')
   assert.strictEqual(
      outcome(requirePasswordChanged, { admin: { mustChangePassword: false } }),
      undefined
   )
})

console.log('\nRules')

check('permissions of each kind', () => {
   assert.deepStrictEqual(permissionsFor(ADMIN_ROLES.SUPER_ADMIN), [...PERMISSIONS])
   assert.deepStrictEqual(permissionsFor(ADMIN_ROLES.BREAK_GLASS), [...PERMISSIONS])
   // A STAFF user with no role document holds nothing.
   assert.deepStrictEqual(permissionsFor(ADMIN_ROLES.STAFF), [])
   assert.deepStrictEqual(permissionsFor(ADMIN_ROLES.STAFF, null), [])
   assert.deepStrictEqual(permissionsFor(ADMIN_ROLES.STAFF, ['orders:write']), ['orders:write'])
   // Anything outside the catalogue is ignored, not granted.
   assert.deepStrictEqual(
      permissionsFor(ADMIN_ROLES.STAFF, ['orders:read', 'made:up', '*']),
      ['orders:read']
   )
   // An unknown kind holds nothing, whatever it claims.
   assert.deepStrictEqual(permissionsFor('OWNER', [...PERMISSIONS]), [])
   assert.deepStrictEqual(permissionsFor(undefined as any, [...PERMISSIONS]), [])
})

check('subset rule', () => {
   assert.ok(isSubset([], []))
   assert.ok(isSubset([], ['orders:read']))
   assert.ok(isSubset(['orders:read'], ['orders:read', 'orders:write']))
   assert.ok(isSubset(['orders:read'], ['orders:read']))
   assert.ok(!isSubset(['orders:read'], []))
   assert.ok(!isSubset(['orders:read', 'users:write'], ['orders:read']))
})

const superAdmin: Actor = { id: 'a', isSuper: true, permissions: [...PERMISSIONS] }
// Holds everything, but is not a super admin.
const breakGlass: Actor = { id: 'b', isSuper: false, permissions: [...PERMISSIONS] }
const staff: Actor = {
   id: 'c',
   isSuper: false,
   roleId: 'role-c',
   permissions: ['users:read', 'users:write', 'roles:write', 'orders:read'],
}

check('what an actor may grant', () => {
   assert.ok(canGrant(superAdmin, [...PERMISSIONS]))
   assert.ok(canGrant(staff, ['orders:read']))
   assert.ok(canGrant(staff, []))
   assert.ok(!canGrant(staff, ['orders:read', 'orders:write']))
   assert.ok(!canGrant({ ...staff, permissions: [] }, ['orders:read']))
})

check('which account kinds an actor may create or assign', () => {
   assert.strictEqual(kindRefusal(superAdmin, ADMIN_ROLES.SUPER_ADMIN), null)
   assert.strictEqual(kindRefusal(staff, ADMIN_ROLES.STAFF), null)
   assert.strictEqual(kindRefusal(staff, ADMIN_ROLES.SUPER_ADMIN), 'FORBIDDEN_TARGET')
   assert.strictEqual(kindRefusal(breakGlass, ADMIN_ROLES.SUPER_ADMIN), 'FORBIDDEN_TARGET')
   // Nobody, not even a super admin.
   assert.strictEqual(kindRefusal(superAdmin, ADMIN_ROLES.BREAK_GLASS), 'FORBIDDEN_TARGET')
})

check('which users an actor may modify or reset', () => {
   const user = (id: string, role: string, permissions: string[]) => ({ id, role, permissions })
   const all = [...PERMISSIONS]

   assert.strictEqual(targetRefusal(superAdmin, user('a', ADMIN_ROLES.SUPER_ADMIN, all)), 'SELF_MODIFY')
   assert.strictEqual(targetRefusal(staff, user('c', ADMIN_ROLES.STAFF, [])), 'SELF_MODIFY')
   assert.strictEqual(targetRefusal(superAdmin, user('x', ADMIN_ROLES.BREAK_GLASS, all)), 'FORBIDDEN_TARGET')
   assert.strictEqual(targetRefusal(superAdmin, user('x', ADMIN_ROLES.SUPER_ADMIN, all)), null)
   assert.strictEqual(targetRefusal(superAdmin, user('x', ADMIN_ROLES.STAFF, ['orders:write'])), null)

   assert.strictEqual(targetRefusal(staff, user('x', ADMIN_ROLES.SUPER_ADMIN, all)), 'FORBIDDEN_TARGET')
   assert.strictEqual(targetRefusal(breakGlass, user('x', ADMIN_ROLES.SUPER_ADMIN, all)), 'FORBIDDEN_TARGET')
   assert.strictEqual(targetRefusal(staff, user('x', ADMIN_ROLES.STAFF, ['orders:read'])), null)
   assert.strictEqual(targetRefusal(staff, user('x', ADMIN_ROLES.STAFF, [])), null)
   // The takeover path: resetting the password of a stronger account.
   assert.strictEqual(
      targetRefusal(staff, user('x', ADMIN_ROLES.STAFF, ['orders:read', 'settings:write'])),
      'ROLE_EXCEEDS_GRANTOR'
   )
})

check('which roles an actor may edit or delete', () => {
   assert.strictEqual(roleEditRefusal(superAdmin, { id: 'r', permissions: [...PERMISSIONS] }), null)
   assert.strictEqual(roleEditRefusal(staff, { id: 'r', permissions: ['orders:read'] }), null)
   assert.strictEqual(roleEditRefusal(staff, { id: 'role-c', permissions: ['orders:read'] }), 'OWN_ROLE')
   assert.strictEqual(
      roleEditRefusal(staff, { id: 'r', permissions: ['settings:write'] }),
      'ROLE_EXCEEDS_GRANTOR'
   )
})

check('last super admin', () => {
   const active = { role: ADMIN_ROLES.SUPER_ADMIN, isActive: true }
   assert.ok(losesActiveSuper(active, { role: ADMIN_ROLES.SUPER_ADMIN, isActive: false }))
   assert.ok(losesActiveSuper(active, { role: ADMIN_ROLES.STAFF, isActive: true }))
   assert.ok(!losesActiveSuper(active, active))
   assert.ok(!losesActiveSuper({ role: ADMIN_ROLES.STAFF, isActive: true }, { role: ADMIN_ROLES.STAFF, isActive: false }))
   assert.ok(!losesActiveSuper({ role: ADMIN_ROLES.SUPER_ADMIN, isActive: false }, { role: ADMIN_ROLES.STAFF, isActive: false }))
})

check('role input', () => {
   const refused = (body: any, requireAll = true) => {
      try {
         parseRoleInput(body, requireAll)
      } catch (err: any) {
         return err.statusCode
      }
      return null
   }

   assert.deepStrictEqual(
      parseRoleInput({ name: '  Front desk ', permissions: ['orders:write', 'orders:read', 'orders:read'] }, true),
      { name: 'Front desk', permissions: ['orders:read', 'orders:write'] }
   )
   assert.deepStrictEqual(parseRoleInput({}, false), {})
   assert.deepStrictEqual(parseRoleInput({ permissions: [] }, false), { permissions: [] })

   // An unknown permission is an error, never silently dropped.
   assert.strictEqual(refused({ name: 'x', permissions: ['orders:read', 'orders:delete'] }), 400)
   assert.strictEqual(refused({ name: 'x', permissions: 'orders:read' }), 400)
   assert.strictEqual(refused({ name: 'x', permissions: [{ $ne: null }] }), 400)
   assert.strictEqual(refused({ name: 'x' }), 400)
   assert.strictEqual(refused({ name: '   ', permissions: [] }), 400)
   assert.strictEqual(refused({ name: 'x'.repeat(61), permissions: [] }), 400)
   assert.strictEqual(refused({ name: { $gt: '' }, permissions: [] }), 400)
   assert.strictEqual(refused({ description: 'x'.repeat(301) }, false), 400)
   // Invisible and look-alike characters must not get a name past the checks.
   ;['Super\u200badmin', 'Sup\u0435r admin', 'Front\u2060 desk', 'Fr\u043ent desk'].forEach((name) =>
      assert.strictEqual(refused({ name, permissions: [] }), 400, `"${name}" should be refused`)
   )
   assert.strictEqual(refused({ name: '\uff33uper admin', permissions: [] }), 400)
   assert.strictEqual(parseRoleInput({ name: 'Réception (L2)', permissions: [] }, true).name, 'Réception (L2)')
   ;['SUPER_ADMIN', 'staff', 'Break-glass', 'super admin'].forEach((name) =>
      assert.strictEqual(refused({ name, permissions: [] }), 400, `"${name}" should be reserved`)
   )
})

console.log(
   failures === 0
      ? '\nAll RBAC checks passed.\n'
      : `\n${failures} RBAC check(s) FAILED.\n`
)

process.exit(failures === 0 ? 0 : 1)
