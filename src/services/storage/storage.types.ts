/**
 * Storage abstraction.
 *
 * Everything that writes a file talks to this interface and nothing else, so
 * moving from the local filesystem to S3 is one env var and one adapter — no
 * controller, model or frontend change.
 *
 * The two visibilities are not cosmetic:
 *
 *   public   — gallery images. Served directly, cacheable, permanent URL fine.
 *   private  — travel documents and anything carrying passport data. §6.5 is
 *              explicit that these must never have a permanent public URL, so
 *              they are only ever reachable through a short-lived signed link.
 *
 * That distinction has to live in the interface rather than in each caller,
 * otherwise one forgotten flag publishes a passport scan.
 */

import type { Readable } from 'stream'

export type Visibility = 'public' | 'private'

export interface UploadInput {
   /**
    * The bytes: in memory, or — for a file too large to hold there, a video —
    * as a stream that is passed on while it arrives, `size` bytes of it
    * exactly. One of the two. Only S3 takes a stream: a video is never kept
    * on this server.
    */
   buffer?: Buffer
   stream?: Readable
   originalName: string
   mimeType: string
   size: number
}

export interface StoredFile {
   /** Opaque storage key. The only thing persisted on a document. */
   key: string
   /**
    * Directly usable URL for public files. Undefined for private ones — those
    * must go through `signedUrl` every time, so a stored URL can never leak.
    */
   url?: string
   originalName: string
   mimeType: string
   size: number
   visibility: Visibility
}

/**
 * A name cut to 120 characters, never through the middle of one: an emoji is
 * two UTF-16 units, and half of one made encodeURIComponent throw (a 500).
 * A lone half already in the name becomes U+FFFD.
 */
export const cutName = (name?: string) =>
   Array.from(
      (name ?? '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
   )
      .slice(0, 120)
      .join('')

/** A file name that is safe inside a Content-Disposition header. */
export const safeDownloadName = (name?: string) =>
   (name ?? '').replace(/[^\w.\- ]+/g, '_').slice(0, 120)

/**
 * Content-Disposition for a download: the name as written, accents and all,
 * for every current browser (RFC 6266 `filename*`), and a plain copy for the
 * rest — 'Contrat signé.pdf' no longer saves as 'Contrat sign_.pdf'.
 */
export const attachmentHeader = (name?: string) => {
   const real = cutName(name)
   const plain = safeDownloadName(real)
   if (!plain) return 'attachment'
   const encoded = encodeURIComponent(real).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
   )
   return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`
}

/**
 * A key the order-documents link may sign: under orders/ (private/orders/ on
 * S3), with no way back up the tree. A supplier's files have their own link,
 * behind inventory:read.
 */
export const isOrderDocumentKey = (key: string) =>
   /^(private\/)?orders\//.test(key) && !key.split(/[\\/]/).includes('..')

export interface StorageAdapter {
   readonly name: string
   save(input: UploadInput, opts: { folder: string; visibility: Visibility }): Promise<StoredFile>
   /**
    * Short-lived link for a private file. `downloadName` is what the browser
    * saves it as — without it a ticket lands in Downloads under its storage
    * key, which the customer will never find again.
    */
   signedUrl(key: string, ttlSeconds: number, downloadName?: string): Promise<string>
   /** Reads a private file after the signature has been verified. */
   read(key: string): Promise<{ stream: NodeJS.ReadableStream; mimeType?: string }>
   remove(key: string): Promise<void>
}
