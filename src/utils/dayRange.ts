/**
 * `?from=2026-10-01&to=2026-10-31` as a range on a date field, both days
 * counted whole and in UTC, like every other date in the system. Undefined
 * when neither is a real date, so a list can skip the filter without checking.
 */
export const dayRange = (from: unknown, to: unknown) => {
   const day = (v: unknown) =>
      typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && writtenDay(v) ? v : null
   const range: { $gte?: Date; $lte?: Date } = {}
   const [first, last] = [day(from), day(to)]
   if (first) range.$gte = new Date(`${first}T00:00:00.000Z`)
   if (last) range.$lte = new Date(`${last}T23:59:59.999Z`)
   return first || last ? range : undefined
}

/**
 * The day a date was written as — `2026-11-03`, or the date part of a full
 * timestamp whatever its zone — at 00:00 UTC. Null when that is no real day:
 * read back, because 2026-02-31 parses, as the 3rd of March.
 */
export function writtenDay(v: unknown): Date | null {
   const written = typeof v === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(v)?.[0] : undefined
   if (!written) return null
   const parsed = new Date(`${written}T00:00:00.000Z`)
   return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(written)
      ? parsed
      : null
}
