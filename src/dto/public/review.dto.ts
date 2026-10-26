import { IReview } from '../../model/reviewModel'
import { FieldMap, present, presentList } from '../../utils/present'

/**
 * A review as the public reads it: who signed it, the stars, the words, and
 * whether they booked with us. Never the customer behind it — no id, phone or
 * e-mail — and nothing of the moderation.
 */
const reviewFields: FieldMap<IReview> = {
   id: (r) => r._id.toString(),
   authorName: (r) => r.authorName,
   rating: (r) => r.rating,
   comment: (r) => r.comment || undefined,
   verified: (r) => Boolean(r.verified),
   createdAt: (r) => r.createdAt?.toISOString?.() ?? r.createdAt,
}

export const presentReviews = (r: IReview[]) => presentList(r, reviewFields)

/** The customer's own review, which they also need to see waiting or refused. */
export const presentOwnReview = (r: IReview | null) =>
   r ? { ...present(r, reviewFields), status: r.status } : null
