import mongoose, { Document, Schema, Types } from 'mongoose'
import { PERMISSIONS } from '../constants/admin.constants'

/**
 * A named set of permissions, assignable to STAFF admin users.
 *
 * Called AccessRole, not AdminRole: `AdminRole` is already the TypeScript type
 * of the account KIND (SUPER_ADMIN / BREAK_GLASS / STAFF) and the two must not
 * be confused.
 */
export interface IAccessRoleDocument extends Document {
   _id: Types.ObjectId
   name: string
   description: string
   permissions: string[]
   createdAt: Date
   updatedAt: Date
}

/** Case-insensitive comparison, shared by the unique index and the lookups. */
export const ROLE_NAME_COLLATION = { locale: 'en', strength: 2 }

const accessRoleSchema = new Schema<IAccessRoleDocument>(
   {
      name: { type: String, required: true, trim: true, maxlength: 60 },
      description: { type: String, trim: true, maxlength: 300, default: '' },
      // Only catalogue strings can be stored; the guard intersects with the
      // catalogue again when it reads them.
      permissions: {
         type: [{ type: String, enum: [...PERMISSIONS] }],
         default: [],
      },
   },
   { timestamps: true }
)

accessRoleSchema.index(
   { name: 1 },
   { unique: true, collation: ROLE_NAME_COLLATION }
)

const AccessRole = mongoose.model<IAccessRoleDocument>(
   'AccessRole',
   accessRoleSchema
)

export default AccessRole
