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

export type Visibility = 'public' | 'private'

export interface UploadInput {
   buffer: Buffer
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

export interface StorageAdapter {
   readonly name: string
   save(input: UploadInput, opts: { folder: string; visibility: Visibility }): Promise<StoredFile>
   /** Short-lived link for a private file. */
   signedUrl(key: string, ttlSeconds: number): Promise<string>
   /** Reads a private file after the signature has been verified. */
   read(key: string): Promise<{ stream: NodeJS.ReadableStream; mimeType?: string }>
   remove(key: string): Promise<void>
}
