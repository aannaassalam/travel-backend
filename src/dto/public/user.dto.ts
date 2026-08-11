import { IUserDocument } from '../../constants/interfaces/IUser'
import { FieldMap, present } from '../../utils/present'

/**
 * Public-surface user DTO. §14.3 rule 2: shares nothing with src/dto/admin —
 * separate file, separate field list, no common base object.
 *
 * Absent on purpose: password, otp, otpExpires, passwordChangedAt, and `role`
 * (the public product has no reason to know it).
 */
const publicUserFields: FieldMap<IUserDocument> = {
   id: (u) => u._id.toString(),
   name: (u) => u.name,
   email: (u) => u.email,
   photo: (u) => u.photo,
   phone: (u) => u.phone,
   city: (u) => u.city,
   country: (u) => u.country,
}

export const presentPublicUser = (user: IUserDocument) =>
   present(user, publicUserFields)
