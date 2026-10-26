import { IPartner } from '../../model/partnerModel'
import { FieldMap, presentList } from '../../utils/present'

/**
 * A partner as the website and the app show it: name, logo, website. Not the
 * order or the on/off switch — those are the panel's.
 */
const publicPartnerFields: FieldMap<IPartner> = {
   id: (p) => p._id.toString(),
   name: (p) => p.name,
   logo: (p) => p.logo,
   // Checked when saved; checked again here because it becomes a link every
   // visitor can follow, and a blank is "no website", not an empty link.
   website: (p) => (/^https?:\/\//i.test(p.website ?? '') ? p.website : undefined),
}

export const presentPublicPartners = (partners: IPartner[]) =>
   presentList(partners, publicPartnerFields)
