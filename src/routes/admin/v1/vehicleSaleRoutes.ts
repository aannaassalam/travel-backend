import express from 'express'

import * as sales from '../../../controllers/admin/vehicleSaleController'
import { boundPagination, requirePermission, requireStepUp } from '../../../middleware/adminAuth'

/**
 * Vehicles for sale: the office's lists, the parkings and the vehicles, all
 * inventory. Registered straight onto the admin router, as transfers, so
 * `npm run check:rbac` reads every route here with its guard. Photos go
 * through the shared /uploads route, as restaurants' and dishes' do.
 */
export const mountVehicleSaleRoutes = (router: express.Router) => {
   const read = requirePermission('inventory:read')
   const write = requirePermission('inventory:write')
   const purge = requirePermission('inventory:delete')

   // --- The lists: types, specifications, accessories ----------------------
   router.get('/vehicle-sales/types', read, sales.listTypes)
   router.post('/vehicle-sales/types', write, sales.createType)
   router.patch('/vehicle-sales/types/:id', write, sales.updateType)
   router.delete('/vehicle-sales/types/:id', purge, requireStepUp, sales.deleteType)

   router.get('/vehicle-sales/specs', read, sales.listSpecs)
   router.post('/vehicle-sales/specs', write, sales.createSpec)
   router.patch('/vehicle-sales/specs/:id', write, sales.updateSpec)
   router.delete('/vehicle-sales/specs/:id', purge, requireStepUp, sales.deleteSpec)

   router.get('/vehicle-sales/accessories', read, sales.listAccessories)
   router.post('/vehicle-sales/accessories', write, sales.createAccessory)
   router.patch('/vehicle-sales/accessories/:id', write, sales.updateAccessory)
   router.delete('/vehicle-sales/accessories/:id', purge, requireStepUp, sales.deleteAccessory)

   // The common list for an empty catalogue: only what is missing.
   router.post('/vehicle-sales/catalogue/starter', write, sales.addStarter)

   // --- Parkings -------------------------------------------------------------
   router.get('/vehicle-sales/parkings', read, boundPagination, sales.listParkings)
   router.post('/vehicle-sales/parkings', write, sales.createParking)
   router.get('/vehicle-sales/parkings/:id', read, sales.getParking)
   router.patch('/vehicle-sales/parkings/:id', write, sales.updateParking)
   router.post('/vehicle-sales/parkings/:id/publish', write, sales.publishParking)
   router.post('/vehicle-sales/parkings/:id/deactivate', write, sales.deactivateParking)
   router.post('/vehicle-sales/parkings/:id/archive', write, sales.archiveParking)

   // --- Vehicles: status only through these, never a PATCH body ------------
   router.get('/vehicle-sales/vehicles', read, boundPagination, sales.listVehicles)
   router.post('/vehicle-sales/vehicles', write, sales.createVehicle)
   router.get('/vehicle-sales/vehicles/:id', read, sales.getVehicle)
   router.patch('/vehicle-sales/vehicles/:id', write, sales.updateVehicle)
   router.post('/vehicle-sales/vehicles/:id/publish', write, sales.publishVehicle)
   router.post('/vehicle-sales/vehicles/:id/deactivate', write, sales.deactivateVehicle)
   router.post('/vehicle-sales/vehicles/:id/archive', write, sales.archiveVehicle)
}
