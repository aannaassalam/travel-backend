import express from 'express'

import * as access from '../../../controllers/admin/accessController'
import { auditLogSummary, listAuditLogs } from '../../../controllers/admin/auditLogController'
import * as customers from '../../../controllers/admin/customerController'
import { getDashboard } from '../../../controllers/admin/dashboardController'
import * as hotels from '../../../controllers/admin/hotelController'
import * as inventoryCsv from '../../../controllers/admin/inventoryCsvController'
import * as listings from '../../../controllers/admin/listingController'
import * as locations from '../../../controllers/admin/locationController'
import * as ops from '../../../controllers/admin/opsController'
import * as restaurants from '../../../controllers/admin/restaurantController'
import * as orders from '../../../controllers/admin/orderController'
import {
   getSignedLink,
   handleUploadErrors,
   serveSignedFile,
   uploadFiles,
   uploadMiddleware,
} from '../../../controllers/admin/uploadController'
import {
   boundPagination,
   protectAdmin,
   requirePasswordChanged,
   requirePermission,
   requireStepUp,
} from '../../../middleware/adminAuth'
import authRouter from './authRouter'

/**
 * §2.1: /admin/v1 is a distinct API surface from /api/v1. It shares services
 * and the database but not controllers, DTOs or auth guards. Adding a role
 * check to the public API is not equivalent — the admin needs fields the public
 * must never receive, and a shared serializer means one missing conditional
 * publishes cost prices to the open internet.
 */
const router = express.Router()

router.use('/auth', authRouter)

/**
 * Signed file download. Mounted BEFORE protectAdmin on purpose: the signature
 * in the query string is the authorisation, which is what allows a voucher link
 * to be sent to a customer who has no login. It expires, so it is not a
 * permanent public URL (§6.5).
 */
router.get('/files/:key', serveSignedFile)

router.use(protectAdmin)
// A temporary password unlocks nothing below this line. /auth/* is mounted
// above, so PATCH /auth/password stays reachable.
router.use(requirePasswordChanged)

// --- Uploads ----------------------------------------------------------------
router.post(
   '/uploads',
   requirePermission('inventory:write'),
   uploadMiddleware,
   handleUploadErrors,
   uploadFiles
)
router.post('/uploads/signed-link', requirePermission('orders:read'), getSignedLink)

router.get('/dashboard', requirePermission('dashboard:read'), getDashboard)

// --- Inventory: hotels (§5.2) ----------------------------------------------
router.get('/hotels', requirePermission('inventory:read'), boundPagination, hotels.listHotels)
router.post('/hotels', requirePermission('inventory:write'), hotels.createHotel)
router.get('/hotels/:id', requirePermission('inventory:read'), hotels.getHotel)
router.patch('/hotels/:id', requirePermission('inventory:write'), hotels.updateHotel)
router.post('/hotels/:id/publish', requirePermission('inventory:write'), hotels.publishHotel)
// Off the website, still in the list; publish brings it back.
router.post('/hotels/:id/deactivate', requirePermission('inventory:write'), hotels.deactivateHotel)
// Archive, never delete (§5.1) — there is deliberately no DELETE route.
router.post('/hotels/:id/archive', requirePermission('inventory:write'), hotels.archiveHotel)
router.post('/hotels/:id/duplicate', requirePermission('inventory:write'), hotels.duplicateHotel)

router.post('/hotels/:id/room-types', requirePermission('inventory:write'), hotels.createRoomType)
router.patch(
   '/hotels/:id/room-types/:roomTypeId',
   requirePermission('inventory:write'),
   hotels.updateRoomType
)

// §5.3 availability calendar
router.get('/hotels/:id/calendar', requirePermission('inventory:read'), hotels.getCalendar)
router.post('/hotels/:id/calendar', requirePermission('inventory:write'), hotels.bulkUpdateCalendar)

// --- Inventory: restaurants and menus (§5.2) --------------------------------
// Same permission as the rest of inventory: a menu is stock like any other.
router.get(
   '/restaurants',
   requirePermission('inventory:read'),
   boundPagination,
   restaurants.listRestaurants
)
router.post('/restaurants', requirePermission('inventory:write'), restaurants.createRestaurant)
router.get('/restaurants/:id', requirePermission('inventory:read'), restaurants.getRestaurant)
router.patch(
   '/restaurants/:id',
   requirePermission('inventory:write'),
   restaurants.updateRestaurant
)
router.post(
   '/restaurants/:id/publish',
   requirePermission('inventory:write'),
   restaurants.publishRestaurant
)
router.post(
   '/restaurants/:id/deactivate',
   requirePermission('inventory:write'),
   restaurants.deactivateRestaurant
)
router.post(
   '/restaurants/:id/duplicate',
   requirePermission('inventory:write'),
   restaurants.duplicateRestaurant
)
// Archive, never delete (§5.1) — there is deliberately no DELETE route.
router.post(
   '/restaurants/:id/archive',
   requirePermission('inventory:write'),
   restaurants.archiveRestaurant
)

router.post(
   '/restaurants/:id/menu',
   requirePermission('inventory:write'),
   restaurants.createMenuItem
)
router.patch(
   '/restaurants/:id/menu/:menuItemId',
   requirePermission('inventory:write'),
   restaurants.updateMenuItem
)
router.post(
   '/restaurants/:id/menu/:menuItemId/archive',
   requirePermission('inventory:write'),
   restaurants.archiveMenuItem
)
// A dish's status moves only through these — never a PATCH body (§BUG-010).
router.post(
   '/restaurants/:id/menu/:menuItemId/publish',
   requirePermission('inventory:write'),
   restaurants.publishMenuItem
)
router.post(
   '/restaurants/:id/menu/:menuItemId/deactivate',
   requirePermission('inventory:write'),
   restaurants.deactivateMenuItem
)

// --- Inventory: flights, bus, cars, activities, properties (§5.2) ----------
router.get('/listings', requirePermission('inventory:read'), boundPagination, listings.listListings)
router.post('/listings', requirePermission('inventory:write'), listings.createListing)
router.get('/listings/:id', requirePermission('inventory:read'), listings.getListing)
router.patch('/listings/:id', requirePermission('inventory:write'), listings.updateListing)
router.post('/listings/:id/publish', requirePermission('inventory:write'), listings.publishListing)
router.post('/listings/:id/deactivate', requirePermission('inventory:write'), listings.deactivateListing)
router.post('/listings/:id/archive', requirePermission('inventory:write'), listings.archiveListing)
router.post('/listings/:id/duplicate', requirePermission('inventory:write'), listings.duplicateListing)
// §5.2 bus recurrence — or the same trip gets hand-entered 90 times.
router.post('/listings/:id/expand-recurrence', requirePermission('inventory:write'), listings.expandRecurrence)

// --- Inventory as spreadsheets: template, export, import (§5.1, §2.2) --------
// `:group` is HOTEL, RESTAURANT, FLIGHT, BUS, CAR, ACTIVITY or PROPERTY. Reading
// the template or an export is inventory:read, like the lists they mirror —
// the list already shows cost prices. Import writes, and is dry-run by default.
router.get(
   '/inventory/:group/import-columns',
   requirePermission('inventory:read'),
   inventoryCsv.importColumns
)
router.get('/inventory/:group/template', requirePermission('inventory:read'), inventoryCsv.template)
router.get('/inventory/:group/export', requirePermission('inventory:read'), inventoryCsv.exportCsv)
router.post('/inventory/:group/import', requirePermission('inventory:write'), inventoryCsv.importCsv)

// --- Bookings (§6) ----------------------------------------------------------
router.get('/orders', requirePermission('orders:read'), boundPagination, orders.listOrders)
router.get('/orders/queue-counts', requirePermission('orders:read'), orders.queueCounts)
router.get('/orders/:id', requirePermission('orders:read'), orders.getOrder)
router.post('/orders/:id/transition', requirePermission('orders:write'), orders.transitionOrder)
router.post('/orders/:id/cash-received', requirePermission('orders:write'), orders.markCashReceived)
router.post('/orders/:id/notes', requirePermission('orders:write'), orders.addInternalNote)
// The file rides with the request. Permission first, so nobody without
// orders:write can make the server buffer an upload.
router.post(
   '/orders/:id/documents',
   requirePermission('orders:write'),
   uploadMiddleware,
   handleUploadErrors,
   orders.attachDocument
)
// A wrong file taken back; refused once the order is completed.
router.delete(
   '/orders/:id/documents/:documentId',
   requirePermission('orders:write'),
   orders.removeDocument
)
// §14.5: unmasking passport data needs step-up re-auth and is logged.
router.post(
   '/orders/:id/travellers/:travellerId/unmask',
   requirePermission('orders:read'),
   requireStepUp,
   orders.unmaskTravellerDocument
)

// --- Customers (§8) ---------------------------------------------------------
router.get('/customers', requirePermission('customers:read'), boundPagination, customers.listCustomers)
router.get('/customers/:id', requirePermission('customers:read'), customers.getCustomer)
router.patch('/customers/:id', requirePermission('customers:write'), customers.updateCustomer)
// §14.4: the most valuable dataset in the system — step-up gated and alerted.
router.post(
   '/customers/export',
   requirePermission('customers:export'),
   requireStepUp,
   customers.exportCustomers
)

// --- Enquiries (§7) ---------------------------------------------------------
router.get('/enquiries', requirePermission('enquiries:read'), boundPagination, ops.listEnquiries)
// Declared before the :id routes so "summary" is never read as an id.
router.get('/enquiries/summary', requirePermission('enquiries:read'), ops.enquirySummary)
router.post('/enquiries/:id/stage', requirePermission('enquiries:write'), ops.updateEnquiryStage)
router.post('/enquiries/:id/notes', requirePermission('enquiries:write'), ops.addEnquiryNote)
router.post('/enquiries/:id/quote', requirePermission('enquiries:write'), ops.quoteEnquiry)

// --- Payments (§9.1) --------------------------------------------------------
// Payment exceptions and FX rates were removed: prices are typed per currency,
// so nothing converts, and the client does not want an exceptions register.
router.get('/payments', requirePermission('payments:read'), boundPagination, ops.listPayments)

// --- Content: versioned policies (§10) --------------------------------------
router.get('/policies', requirePermission('content:read'), ops.listPolicies)
// Editing creates a NEW version; there is deliberately no PATCH on policy text.
router.post('/policies', requirePermission('content:write'), ops.createPolicyVersion)
router.post('/policies/:id/publish', requirePermission('content:write'), ops.setPolicyLive)

// --- Notifications (§11) ----------------------------------------------------
router.get('/notifications/templates', requirePermission('notifications:read'), ops.listTemplates)
router.put('/notifications/templates', requirePermission('notifications:write'), ops.upsertTemplate)
router.post('/notifications/test', requirePermission('notifications:write'), ops.sendTestNotification)

// --- Settings (§12) ---------------------------------------------------------
router.get('/settings', requirePermission('settings:read'), ops.getSettingsHandler)
// §1.3: settings changes require step-up re-authentication.
router.patch('/settings', requirePermission('settings:write'), requireStepUp, ops.updateSettings)

// --- Locations & serviced routes (§12) --------------------------------------
router.get('/locations', requirePermission('inventory:read'), locations.listLocations)
router.post('/locations', requirePermission('inventory:write'), locations.createLocation)
router.patch('/locations/:id', requirePermission('inventory:write'), locations.updateLocation)
router.get('/routes', requirePermission('inventory:read'), locations.listRoutes)
router.post('/routes', requirePermission('inventory:write'), locations.createRoute)
router.patch('/routes/:id', requirePermission('inventory:write'), locations.updateRoute)

// Must stay above any future /audit-logs/:id.
router.get('/audit-logs/summary', requirePermission('audit:read'), auditLogSummary)
router.get('/audit-logs', requirePermission('audit:read'), boundPagination, listAuditLogs)

// --- Access control: roles and admin-panel users ----------------------------
// Every mutation here changes who can do what, so every one needs step-up.
// The permission only opens the door: what the caller may grant, and to whom,
// is decided in accessController. `npm run check:rbac` verifies this table.
router.get('/roles', requirePermission('roles:read'), access.listRoles)
router.post('/roles', requirePermission('roles:write'), requireStepUp, access.createRole)
router.patch('/roles/:id', requirePermission('roles:write'), requireStepUp, access.updateRole)
router.delete('/roles/:id', requirePermission('roles:write'), requireStepUp, access.deleteRole)

router.get('/users', requirePermission('users:read'), access.listUsers)
// Must stay above /users/:id.
router.get('/users/assignable-roles', requirePermission('users:write'), access.assignableRoles)
router.post('/users', requirePermission('users:write'), requireStepUp, access.createUser)
// Deactivate, never delete — audit-log entries reference these accounts, so
// there is deliberately no DELETE route.
router.patch('/users/:id', requirePermission('users:write'), requireStepUp, access.updateUser)
router.post(
   '/users/:id/reset-password',
   requirePermission('users:write'),
   requireStepUp,
   access.resetUserPassword
)

export default router
