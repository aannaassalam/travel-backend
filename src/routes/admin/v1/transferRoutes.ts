import express from 'express'

import * as fleet from '../../../controllers/admin/fleetController'
import * as rides from '../../../controllers/admin/rideController'
import { handleUploadErrors, uploadFiles, uploadMiddleware } from '../../../controllers/admin/uploadController'
import { boundPagination, requirePermission, requireStepUp } from '../../../middleware/adminAuth'

/**
 * Transfers. The fleet (categories, vehicles, drivers, places) is inventory;
 * the rides are bookings, under the orders permissions. Registered straight
 * onto the admin router — no nested router — so `npm run check:rbac` reads
 * every route here with its guard, like the rest of the table.
 */
export const mountTransferRoutes = (router: express.Router) => {
   // --- Fleet: vehicle categories and their prices ------------------------
   router.get('/transfers/categories', requirePermission('inventory:read'), fleet.listCategories)
   router.post('/transfers/categories', requirePermission('inventory:write'), fleet.createCategory)
   router.patch('/transfers/categories/:id', requirePermission('inventory:write'), fleet.updateCategory)
   router.delete('/transfers/categories/:id', requirePermission('inventory:delete'), requireStepUp, fleet.deleteCategory)

   // --- Fleet: vehicles ---------------------------------------------------
   router.get('/transfers/vehicles', requirePermission('inventory:read'), fleet.listVehicles)
   router.post('/transfers/vehicles', requirePermission('inventory:write'), fleet.createVehicle)
   router.patch('/transfers/vehicles/:id', requirePermission('inventory:write'), fleet.updateVehicle)
   router.delete('/transfers/vehicles/:id', requirePermission('inventory:delete'), requireStepUp, fleet.deleteVehicle)

   // --- Fleet: drivers ----------------------------------------------------
   router.get('/transfers/drivers', requirePermission('inventory:read'), fleet.listDrivers)
   // Who is free for a ride: asked from the rides board, so the orders permission.
   router.get('/transfers/drivers/available', requirePermission('orders:read'), fleet.listAvailableDrivers)
   router.post('/transfers/drivers', requirePermission('inventory:write'), fleet.createDriver)
   router.patch('/transfers/drivers/:id', requirePermission('inventory:write'), fleet.updateDriver)
   // A credential, so it is audited; the office tells the driver in person.
   router.post('/transfers/drivers/:id/password', requirePermission('inventory:write'), fleet.setDriverPassword)
   router.delete('/transfers/drivers/:id', requirePermission('inventory:delete'), requireStepUp, fleet.deleteDriver)

   // --- Fleet: saved pick-up and drop-off places ---------------------------
   router.get('/transfers/places', requirePermission('inventory:read'), fleet.listPlaces)
   router.post('/transfers/places', requirePermission('inventory:write'), fleet.createPlace)
   router.patch('/transfers/places/:id', requirePermission('inventory:write'), fleet.updatePlace)
   router.delete('/transfers/places/:id', requirePermission('inventory:delete'), requireStepUp, fleet.deletePlace)

   // Pictures of categories, vehicles and drivers: permission before any byte
   // is buffered, then pinned to the transfers' own public folder.
   router.post(
      '/transfers/uploads',
      requirePermission('inventory:write'),
      uploadMiddleware,
      handleUploadErrors,
      fleet.transferImagesOnly,
      uploadFiles
   )

   // --- Rides ---------------------------------------------------------------
   router.get('/transfers/rides', requirePermission('orders:read'), boundPagination, rides.listRides)
   router.get('/transfers/rides/:id', requirePermission('orders:read'), rides.getRide)
   router.post('/transfers/rides/:id/assign', requirePermission('orders:write'), rides.assign)
   router.post('/transfers/rides/:id/unassign', requirePermission('orders:write'), rides.unassign)
   router.post('/transfers/rides/:id/start', requirePermission('orders:write'), rides.start)
   router.post('/transfers/rides/:id/end', requirePermission('orders:write'), rides.end)
   router.post('/transfers/rides/:id/cancel', requirePermission('orders:write'), rides.cancel)
}
