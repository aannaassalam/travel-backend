import mongoose, { Document, Schema, Types } from 'mongoose'
import { Localized, localizedField } from './shared.schema'

/**
 * The office's saved pick-up and drop-off points of a city — the airport, the
 * big hotels, the station — offered first when a customer types a place, so
 * the usual ride needs no map and no typing at all.
 */
export const PLACE_KINDS = ['AIRPORT', 'HOTEL', 'STATION', 'PORT', 'LANDMARK', 'OTHER'] as const
export type PlaceKind = (typeof PLACE_KINDS)[number]

export interface ITransferPlace extends Document {
   _id: Types.ObjectId
   city: string
   name: Localized
   kind: PlaceKind
   lat: number
   lng: number
   isActive: boolean
   sortOrder: number
   createdAt: Date
   updatedAt: Date
}

const transferPlaceSchema = new Schema<ITransferPlace>(
   {
      city: { type: String, required: true, trim: true },
      name: localizedField({ required: true }),
      kind: { type: String, enum: PLACE_KINDS, default: 'OTHER' },
      lat: { type: Number, required: true, min: -90, max: 90 },
      lng: { type: Number, required: true, min: -180, max: 180 },
      isActive: { type: Boolean, default: true },
      sortOrder: { type: Number, default: 0 },
   },
   { timestamps: true, optimisticConcurrency: true }
)

transferPlaceSchema.index({ city: 1, isActive: 1, sortOrder: 1 })

export const TransferPlace = mongoose.model<ITransferPlace>('TransferPlace', transferPlaceSchema)
