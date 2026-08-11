/**
 * Demo inventory and orders for local development.
 *
 *   npm run seed:demo
 *
 * Development only — refuses to run against NODE_ENV=production so a real
 * catalogue can never be polluted with fixtures.
 */
import dotenv from 'dotenv'
import mongoose from 'mongoose'

dotenv.config()

import { buildMongoUri } from '../config/db.config'
import {
   FULFILMENT_STATUS,
   LISTING_STATUS,
   ORDER_STATUS,
   PAYMENT_STATUS,
   VERTICALS,
} from '../constants/domain.constants'
import { Customer } from '../model/customerModel.admin'
import { Enquiry, PaymentException } from '../model/enquiryModel'
import SettingsModel, { FxRate, PolicyVersion } from '../model/settingsModel'
import { Hotel, RatePlan, RoomType } from '../model/hotelModel'
import { Order } from '../model/orderModel'

const usd = (dollars: number) => Math.round(dollars * 100)
const day = (offset: number) => {
   const d = new Date()
   d.setUTCHours(0, 0, 0, 0)
   d.setUTCDate(d.getUTCDate() + offset)
   return d
}

const run = async () => {
   if (process.env.NODE_ENV === 'production') {
      throw new Error('seed:demo refuses to run with NODE_ENV=production')
   }
   await mongoose.connect(buildMongoUri())

   await Promise.all([
      Hotel.deleteMany({}),
      RoomType.deleteMany({}),
      RatePlan.deleteMany({}),
      Order.deleteMany({}),
      Customer.deleteMany({}),
      Enquiry.deleteMany({}),
      PaymentException.deleteMany({}),
      PolicyVersion.deleteMany({}),
      FxRate.deleteMany({}),
      SettingsModel.deleteMany({}),
   ])

   const hotels = await Hotel.create([
      {
         name: { fr: 'Hôtel Memling', en: 'Memling Hotel' },
         slug: 'hotel-memling-kinshasa',
         city: 'Kinshasa',
         status: LISTING_STATUS.PUBLISHED,
         stars: 4,
         address: 'Avenue République du Tchad, Gombe',
         description: { fr: 'Hôtel d’affaires au cœur de Gombe.', en: 'Business hotel in Gombe.' },
         amenities: ['WIFI', 'POOL', 'RESTAURANT', 'PARKING'],
         images: ['/assets/images/hotel-1.jpg'],
         supplier: 'Memling Group',
      },
      {
         name: { fr: 'Grand Hôtel de Lubumbashi', en: 'Lubumbashi Grand Hotel' },
         slug: 'lubumbashi-grand-hotel',
         city: 'Lubumbashi',
         status: LISTING_STATUS.PUBLISHED,
         stars: 3,
         description: { fr: 'Confort moderne au centre-ville.' },
         amenities: ['WIFI', 'RESTAURANT'],
         images: ['/assets/images/hotel-2.jpg'],
         supplier: 'Katanga Hospitality',
      },
      {
         name: { fr: 'Lodge du Lac de Goma', en: 'Goma Lakeside Lodge' },
         slug: 'goma-lakeside-lodge',
         city: 'Goma',
         status: LISTING_STATUS.DRAFT,
         stars: 3,
         description: { fr: '' },
         images: [],
      },
   ])

   const rooms = await RoomType.create([
      { hotel: hotels[0]._id, name: { fr: 'Chambre Standard', en: 'Standard Room' }, maxAdults: 2, beds: '1 double', status: LISTING_STATUS.PUBLISHED },
      { hotel: hotels[0]._id, name: { fr: 'Chambre Exécutive', en: 'Executive Room' }, maxAdults: 2, maxChildren: 1, beds: '1 king', status: LISTING_STATUS.PUBLISHED },
      { hotel: hotels[0]._id, name: { fr: 'Suite', en: 'Suite' }, maxAdults: 3, maxChildren: 2, beds: '1 king + sofa', status: LISTING_STATUS.PUBLISHED },
      { hotel: hotels[1]._id, name: { fr: 'Chambre Standard', en: 'Standard Room' }, maxAdults: 2, beds: '2 singles', status: LISTING_STATUS.PUBLISHED },
   ])

   // 45 nights of availability, with some already sold and some past-dated so
   // spoilage and at-risk tiles have something real to report.
   const cells: any[] = []
   // Illustrative CDF/EUR prices are typed here exactly as an administrator
   // would type them — deliberately NOT derived from the USD figure.
   const CDF_PER_USD = 2800
   const EUR_PER_USD = 0.92
   for (const room of rooms) {
      const fr = room.name?.fr ?? ''
      const base = fr.includes('Suite') ? 260 : fr.includes('Exéc') ? 180 : 120
      for (let i = -10; i < 35; i++) {
         const allotment = 5
         const sold = i < 0 ? Math.floor(Math.random() * 4) : i < 8 ? Math.floor(Math.random() * 3) : 0
         cells.push({
            hotel: room.hotel,
            roomType: room._id,
            date: day(i),
            costPrice: { USD: usd(base * 0.7) },
            sellPrice: {
               USD: usd(base),
               CDF: Math.round(base * CDF_PER_USD) * 100,
               EUR: usd(Math.round(base * EUR_PER_USD)),
            },
            allotment,
            sold,
         })
      }
   }
   await RatePlan.insertMany(cells)

   const customers = await Customer.create([
      { firstName: 'Jean', lastName: 'Mukendi', phone: '+243810000001', email: 'jean@example.cd', city: 'Kinshasa' },
      { firstName: 'Aline', lastName: 'Kabeya', phone: '+243810000002', email: 'aline@example.cd', city: 'Lubumbashi' },
      { firstName: 'Patrick', lastName: 'Ilunga', phone: '+243810000003', city: 'Goma', noShowCount: 1 },
   ])

   const mkItem = (roomIdx: number, nights: number, qty: number) => {
      const room = rooms[roomIdx]
      const fr = room.name?.fr ?? ''
      const base = fr.includes('Suite') ? 260 : fr.includes('Exéc') ? 180 : 120
      return {
         vertical: VERTICALS.HOTEL,
         listingId: room.hotel,
         listingLabel: `${hotels.find((h) => h._id.equals(room.hotel))?.name?.fr} — ${fr}`,
         roomTypeId: room._id,
         startDate: day(3),
         endDate: day(3 + nights),
         quantity: qty,
         unitSellPrice: usd(base),
         unitCostPrice: usd(base * 0.7),
         lineTotal: usd(base * nights * qty),
         lineCost: usd(base * 0.7 * nights * qty),
      }
   }

   await Order.create([
      {
         reference: 'TRV-2601-0001',
         status: ORDER_STATUS.CONFIRMED,
         paymentStatus: PAYMENT_STATUS.PAID,
         // Paid but no documents — lands in "Needs action" (§6.1).
         fulfilmentStatus: FULFILMENT_STATUS.DOCUMENTS_PENDING,
         customer: customers[0]._id,
         items: [mkItem(0, 3, 1)],
         travellers: [{ firstName: 'Jean', lastName: 'Mukendi', documentType: 'PASSPORT', documentNumber: 'OP1234567' }],
         total: usd(360),
         chargedTotal: usd(360),
         paidAt: new Date(),
         travelDate: day(3),
         consent: {
            policyVersionLabel: 'No-refund v1 (fr)',
            textShown: 'Toutes les ventes sont définitives. Aucun remboursement.',
            locale: 'fr',
            acceptedAt: new Date(),
            ip: '41.243.0.10',
         },
         timeline: [{ event: 'ORDER_CREATED' }, { event: 'PAYMENT_RECEIVED' }],
      },
      {
         reference: 'TRV-2601-0002',
         status: ORDER_STATUS.SUBMITTED,
         paymentStatus: PAYMENT_STATUS.UNPAID,
         paymentMethod: 'CASH',
         customer: customers[1]._id,
         items: [mkItem(3, 2, 2)],
         total: usd(480),
         // Inside 24h — shows on the dashboard chase list (§4.2).
         cashDeadline: new Date(Date.now() + 18 * 3600 * 1000),
         travelDate: day(5),
         timeline: [{ event: 'ORDER_CREATED' }],
      },
      {
         reference: 'TRV-2601-0003',
         status: ORDER_STATUS.SUBMITTED,
         paymentStatus: PAYMENT_STATUS.FAILED,
         customer: customers[2]._id,
         items: [mkItem(1, 1, 1)],
         total: usd(180),
         travelDate: day(9),
         timeline: [{ event: 'ORDER_CREATED' }, { event: 'PAYMENT_FAILED' }],
      },
      {
         reference: 'TRV-2601-0004',
         status: ORDER_STATUS.CONFIRMED,
         paymentStatus: PAYMENT_STATUS.PAID,
         fulfilmentStatus: FULFILMENT_STATUS.DOCUMENTS_ISSUED,
         customer: customers[0]._id,
         items: [mkItem(2, 4, 1)],
         total: usd(1040),
         chargedTotal: usd(1040),
         paidAt: new Date(),
         travelDate: day(1),
         documents: [{ kind: 'VOUCHER', fileName: 'voucher-0004.pdf', version: 1 }],
         timeline: [{ event: 'ORDER_CREATED' }, { event: 'DOCUMENTS_ISSUED' }],
      },
   ])

   // §7 enquiries — one already past the 4h SLA so the breach state is visible.
   await Enquiry.create([
      {
         reference: 'ENQ-2601-0001',
         kind: 'PROPERTY',
         stage: 'NEW',
         customerName: 'Marie Tshibangu',
         phone: '+243810000010',
         email: 'marie@example.cd',
         message: 'Intéressée par la villa à Gombe. Quel est le prix final ?',
         listingLabel: 'Villa 4 chambres — Gombe',
         createdAt: new Date(Date.now() - 9 * 3600 * 1000),
      },
      {
         reference: 'ENQ-2601-0002',
         kind: 'REQUEST_TO_BOOK',
         stage: 'CONTACTED',
         vertical: 'HOTEL',
         customerName: 'Didier Nsimba',
         phone: '+243810000011',
         message: 'Besoin de 3 chambres à Lubumbashi du 12 au 15.',
         firstContactAt: new Date(Date.now() - 2 * 3600 * 1000),
         contactLog: [{ kind: 'CALL', detail: 'Called, awaiting dates', actorEmail: 'admin@yopmail.com' }],
      },
      {
         reference: 'ENQ-2601-0003',
         kind: 'PROPERTY',
         stage: 'QUOTED',
         customerName: 'Grace Mbala',
         phone: '+243810000012',
         message: 'Terrain à Goma, 500m².',
         quotedAmount: usd(45000),
         firstContactAt: new Date(Date.now() - 26 * 3600 * 1000),
      },
   ])

   // §10: policy versions are immutable; this is the live no-refund text.
   await PolicyVersion.create([
      {
         kind: 'NO_REFUND',
         locale: 'fr',
         label: 'No-refund v1 (fr)',
         body: 'Toutes les ventes sont définitives. Aucun remboursement ne sera accordé après confirmation de la commande.',
         isLive: true,
      },
      {
         kind: 'NO_REFUND',
         locale: 'en',
         label: 'No-refund v1 (en)',
         body: 'All sales are final. No refunds are issued once an order is confirmed.',
         isLive: true,
      },
   ])

   // §9.1: one approved rate and one awaiting human approval.
   await FxRate.create([
      { currency: 'CDF', rate: 2800, spreadPercent: 2, status: 'APPROVED', effectiveFrom: new Date(), approvedAt: new Date() },
      { currency: 'EUR', rate: 0.92, spreadPercent: 1, status: 'PENDING', source: 'REFERENCE_FEED' },
   ])

   console.log(
      `Seeded ${hotels.length} hotels · ${rooms.length} room types · ${cells.length} nights · ${customers.length} customers · 4 orders · 3 enquiries · 2 policies · 2 FX rates`
   )
   await mongoose.disconnect()
}

run().catch((e) => {
   console.error(e.message)
   process.exit(1)
})
