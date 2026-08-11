/**
 * §14.3 rule 1: explicit allow-list serialisation. Never return an ORM entity,
 * never spread one into a response. A new database column must not
 * automatically surface in any API response.
 *
 * Every admin and public response object is built by `present`/`presentList`
 * from a field list declared in src/dto. Adding a column to a model changes no
 * response until someone adds it to a DTO on purpose.
 */

export type FieldMap<T> = {
   [K: string]: (doc: T) => any
}

const isEmpty = (v: any) => v === undefined

export const present = <T>(doc: T | null | undefined, fields: FieldMap<T>) => {
   if (!doc) return null
   return Object.entries(fields).reduce<Record<string, any>>(
      (acc, [key, pick]) => {
         const value = pick(doc)
         if (!isEmpty(value)) acc[key] = value
         return acc
      },
      {}
   )
}

export const presentList = <T>(docs: T[] | null | undefined, fields: FieldMap<T>) =>
   (docs || []).map((d) => present(d, fields))

/**
 * §14.3 rule 3 + §14.5: masked by default. Unmasking is a deliberate,
 * reason-required, logged action — never a default serialisation.
 */
export const maskPhone = (phone?: string) => {
   if (!phone) return undefined
   const tail = phone.slice(-3)
   return `${'•'.repeat(Math.max(phone.length - 3, 0))}${tail}`
}

export const maskDocumentNumber = (value?: string) => {
   if (!value) return undefined
   return `${'•'.repeat(Math.max(value.length - 4, 0))}${value.slice(-4)}`
}

export const maskEmail = (email?: string) => {
   if (!email) return undefined
   const [local, domain] = email.split('@')
   if (!domain) return '•'.repeat(email.length)
   return `${local.slice(0, 2)}${'•'.repeat(Math.max(local.length - 2, 0))}@${domain}`
}
