import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

import {
   safeDownloadName,
   StorageAdapter,
   StoredFile,
   UploadInput,
   Visibility,
} from './storage.types'

/**
 * Local filesystem storage.
 *
 *   <STORAGE_ROOT>/public/<folder>/<key>   served statically at /uploads
 *   <STORAGE_ROOT>/private/<folder>/<key>  only via a signed link
 *
 * Private files get a real signed URL — an HMAC over key + expiry — rather than
 * an unguessable path. An unguessable path is still a permanent URL once it
 * leaks, which is exactly what §6.5 forbids for documents carrying passport
 * data. This mirrors what S3 presigned URLs do, so behaviour does not change
 * when the driver is switched.
 */

const ROOT = path.resolve(process.env.STORAGE_ROOT || 'storage')
const PUBLIC_BASE = process.env.STORAGE_PUBLIC_URL || '/uploads'

const signingSecret = () => {
   const s = process.env.STORAGE_SIGNING_SECRET || process.env.ADMIN_JWT_SECRET
   if (!s) throw new Error('STORAGE_SIGNING_SECRET (or ADMIN_JWT_SECRET) is required')
   return s
}

/** Refuses anything that could escape the storage root. */
const resolveSafe = (visibility: Visibility, key: string) => {
   const base = path.join(ROOT, visibility)
   const full = path.resolve(base, key)
   if (full !== base && !full.startsWith(base + path.sep)) {
      throw new Error('Invalid storage key')
   }
   return full
}

const extensionFor = (originalName: string) => {
   const ext = path.extname(originalName).toLowerCase()
   // Only ever write a known-safe extension — never echo user input into a path.
   return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : ''
}

export class LocalDiskStorage implements StorageAdapter {
   readonly name = 'local'

   async save(
      input: UploadInput,
      opts: { folder: string; visibility: Visibility }
   ): Promise<StoredFile> {
      const folder = opts.folder.replace(/[^a-z0-9/_-]/gi, '')
      const key = `${folder}/${crypto.randomUUID()}${extensionFor(input.originalName)}`
      const full = resolveSafe(opts.visibility, key)

      await fs.promises.mkdir(path.dirname(full), { recursive: true })
      await fs.promises.writeFile(full, input.buffer)

      return {
         key,
         // Only public files carry a URL — see storage.types.
         url: opts.visibility === 'public' ? `${PUBLIC_BASE}/${key}` : undefined,
         originalName: input.originalName,
         mimeType: input.mimeType,
         size: input.size,
         visibility: opts.visibility,
      }
   }

   async signedUrl(key: string, ttlSeconds: number, downloadName?: string): Promise<string> {
      const expires = Math.floor(Date.now() / 1000) + ttlSeconds
      const sig = LocalDiskStorage.sign(key, expires)
      const name = safeDownloadName(downloadName)
      // The name is cosmetic and outside the signature; it is sanitised again
      // where it is used.
      return (
         `/admin/v1/files/${encodeURIComponent(key)}?expires=${expires}&signature=${sig}` +
         (name ? `&name=${encodeURIComponent(name)}` : '')
      )
   }

   static sign(key: string, expires: number) {
      return crypto
         .createHmac('sha256', signingSecret())
         .update(`${key}:${expires}`)
         .digest('hex')
   }

   /** Constant-time compare so the signature cannot be probed byte by byte. */
   static verify(key: string, expires: number, signature: string) {
      if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false
      const expected = LocalDiskStorage.sign(key, expires)
      const a = Buffer.from(expected)
      const b = Buffer.from(String(signature))
      return a.length === b.length && crypto.timingSafeEqual(a, b)
   }

   async read(key: string) {
      const full = resolveSafe('private', key)
      // A directory passes an access() check and then kills the process when
      // it is streamed, so it has to be a file.
      const stat = await fs.promises.stat(full)
      if (!stat.isFile()) throw new Error('Not a file')
      return { stream: fs.createReadStream(full) }
   }

   async remove(key: string) {
      for (const visibility of ['public', 'private'] as Visibility[]) {
         try {
            await fs.promises.unlink(resolveSafe(visibility, key))
            return
         } catch {
            // Not in this bucket — try the other.
         }
      }
   }
}

export const PUBLIC_DIR = path.join(ROOT, 'public')
export const PUBLIC_URL_PREFIX = PUBLIC_BASE
