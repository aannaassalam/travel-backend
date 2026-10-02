/**
 * Allow-list a request body down to an explicit set of editable fields.
 *
 * The defence against mass assignment (BUG-010): spreading `...req.body` into a
 * create/update lets a caller set ANY field the schema has — status, slug,
 * quantitySold, createdBy — not only the ones the form shows. Picking names the
 * fields that may be written and drops everything else.
 */
export const pick = <T extends Record<string, any>>(
   src: T | undefined | null,
   keys: readonly string[]
): Record<string, any> => {
   const out: Record<string, any> = {}
   if (!src || typeof src !== 'object') return out
   for (const k of keys) if (src[k] !== undefined) out[k] = src[k]
   return out
}
