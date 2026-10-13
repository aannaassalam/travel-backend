/**
 * Whether an address is one our own storage hands out for a public file in
 * `folder`: <storage>/[public/]<folder>/<generated name><extension>, and
 * nothing else.
 *
 * "Starts with our storage" is not enough for an address that goes into a page
 * every visitor loads: that also covers the private documents folder, another
 * module's files, and anything a quote or a second slash can be made to mean.
 *
 * `extension` is a pattern: `\\.(mp4|webm)`, or `(\\.[a-z0-9]{1,5})?`.
 *
 * STORAGE_PUBLIC_URL_PREVIOUS (comma-separated) names addresses the storage
 * used to answer with — the bare bucket, once a CDN is put in front of it.
 * Files stored under them are still ours: without it, copying a hotel whose
 * video (or re-saving a page whose picture) carries the old address is refused.
 */
export const isOwnPublicFile = (
   raw: unknown,
   folder: string,
   extension: string,
   /**
    * Whether an address on this server's own disk (`/uploads/…`) counts even
    * when the storage is elsewhere. Yes for pictures, which were kept there
    * before S3. No for videos: one is never stored on the server.
    */
   onDisk = true
): raw is string => {
   if (typeof raw !== 'string' || raw.length > 500) return false
   const ours = [
      process.env.STORAGE_PUBLIC_URL,
      ...(process.env.STORAGE_PUBLIC_URL_PREVIOUS ?? '').split(','),
      onDisk ? '/uploads' : '',
   ]
      .map((prefix) => (prefix ?? '').trim())
      .filter(Boolean)
      // As the storage adapters trim it before building an address.
      .map((prefix) => prefix.replace(/\/+$/, ''))
   const shape = new RegExp(`^/(public/)?${folder}/[0-9a-f-]{36}${extension}$`)
   return ours.some((prefix) => raw.startsWith(`${prefix}/`) && shape.test(raw.slice(prefix.length)))
}
