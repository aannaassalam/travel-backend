import { NextFunction, Request, Response } from 'express'
import multer from 'multer'
import { PassThrough, Readable, Transform } from 'stream'

import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import { VIDEO_FOLDER } from '../../model/shared.schema'
import { LocalDiskStorage, storage, StoredFile, Visibility } from '../../services/storage'
import { safeDownloadName } from '../../services/storage/storage.types'
import { recordAudit } from '../../services/auditLog.service'
import AppError from '../../utils/appError'
import catchAsync from '../../utils/catchAsync'
import { sendResponse } from '../../utils/response'

/**
 * File uploads.
 *
 * multer keeps the bytes in memory and hands them to the storage adapter, which
 * is what makes the driver swappable — multer's own diskStorage would hardcode
 * the local filesystem into the request pipeline.
 *
 * Memory buffering is fine at these sizes (8 MB images, 15 MB documents).
 * Video is the exception and has its own route below: it is passed straight
 * on to S3 as it arrives, so a 100 MB clip is never held in memory — nor
 * written to this server at all.
 */

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif']
const DOCUMENT_TYPES = [...IMAGE_TYPES, 'application/pdf']

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024

export const uploadMiddleware = multer({
   storage: multer.memoryStorage(),
   // Browsers send a file's name as UTF-8. Read as Latin-1 (the library's
   // default) "Reçu n°12.pdf" is stored as "ReÃ§u nÂ°12.pdf" — and a booking
   // document's name is shown to the customer.
   defParamCharset: 'utf8',
   limits: { fileSize: MAX_DOCUMENT_BYTES, files: 10 },
   fileFilter: (_req, file, cb) => {
      // Allow-list, not a block-list: an unknown type is refused rather than
      // stored and worried about later.
      if (!DOCUMENT_TYPES.includes(file.mimetype)) {
         return cb(new AppError(`Unsupported file type: ${file.mimetype}`, 400))
      }
      cb(null, true)
   },
}).array('files', 10)

/**
 * The optional video of a hotel, restaurant or listing.
 *
 * ponytail: stored as uploaded — no transcoding, one quality. That is why the
 * size is capped where a minute or so off a phone fits, and why the website
 * fetches nothing until the visitor presses play. If videos need to be longer,
 * or lighter on a 3G connection, the next step is a transcoding service (or a
 * video host) rather than a bigger number here. A replaced or removed video
 * also stays in storage: a copied item shares the file with its original, so
 * it cannot simply be deleted — sweep unreferenced files if the space matters.
 */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024
// What a browser calls an MP4, a QuickTime movie (an iPhone's), an M4V and a WebM.
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/x-m4v', 'video/webm']

/**
 * What the file really is, from its first bytes — the name and the type the
 * browser sent are only what the sender says. An MP4 and a QuickTime movie
 * share one structure (a `ftyp` box naming the brand), and are stored alike:
 * browsers play a phone's .mov when it is served as MP4, and many refuse it
 * under its own type. HEIC and AVIF pictures wear the same box and are not
 * videos. WebM opens with the EBML mark.
 */
const sniffVideo = (head: Buffer): { ext: string; mimeType: string } | null => {
   if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp') {
      const brand = head.toString('latin1', 8, 12)
      if (/^(hei[cxms]|hev[cxms]|mif1|msf1|avi[fs])$/.test(brand)) return null
      return { ext: '.mp4', mimeType: 'video/mp4' }
   }
   if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) {
      return { ext: '.webm', mimeType: 'video/webm' }
   }
   return null
}

const NOT_WHOLE = 'The video did not arrive whole. Try again.'

/**
 * The first `n` bytes of a stream, and the whole stream again behind them —
 * so what the file is can be decided before any of it is passed on.
 */
const peek = (source: Readable, n: number) =>
   new Promise<{ head: Buffer; whole: Readable }>((resolve, reject) => {
      const got: Buffer[] = []
      let length = 0
      const hand = (ended: boolean) => {
         source.off('data', onData)
         source.off('end', onEnd)
         source.off('error', reject)
         const first = Buffer.concat(got)
         const whole = new PassThrough()
         source.on('error', (err) => whole.destroy(err))
         if (ended) whole.end(first)
         else {
            whole.write(first)
            source.pipe(whole)
         }
         resolve({ head: first.subarray(0, n), whole })
      }
      const onData = (chunk: Buffer) => {
         got.push(chunk)
         length += chunk.length
         if (length >= n) {
            source.pause()
            hand(false)
         }
      }
      const onEnd = () => hand(true)
      source.on('data', onData)
      source.once('end', onEnd)
      source.once('error', reject)
   })

/**
 * Lets through exactly `size` bytes. S3 is told the length before the first
 * byte: more than that would be cut off there and stored as a broken file,
 * and fewer leaves S3 waiting for the rest until it gives up.
 */
const exactly = (size: number) => {
   let seen = 0
   return new Transform({
      transform(chunk: Buffer, _encoding, done) {
         seen += chunk.length
         done(seen > size ? new AppError(NOT_WHOLE, 400) : null, chunk)
      },
      flush(done) {
         done(seen === size ? null : new AppError(NOT_WHOLE, 400))
      },
   })
}

/**
 * Where an uploaded video goes: straight to S3, as it arrives. It is never
 * written to this server — not to its disk, not for a moment — and a server
 * whose storage is not S3 refuses it rather than keep it.
 *
 * The form says how large the file is (`size`, sent ahead of the file),
 * because S3 has to be told before the first byte. What the file is, is read
 * off its first bytes, before any of it is passed on.
 */
const videoToS3: multer.StorageEngine = {
   _handleFile(req, file, cb) {
      let answered = false
      const answer = (err: unknown, stored?: StoredFile) => {
         if (answered) return
         answered = true
         // Whatever is still arriving is read to its end and thrown away, or
         // the request never finishes and the refusal is never sent.
         if (err) file.stream.resume()
         cb(err as Error | null, stored ? ({ stored, size: stored.size } as Partial<Express.Multer.File>) : undefined)
      }
      const adapter = storage()
      if (adapter.name !== 's3') {
         return answer(
            new AppError('Videos are stored in S3, and this server is not set up to use it.', 503)
         )
      }
      const size = Number((req.body as Record<string, unknown> | undefined)?.size)
      if (!Number.isSafeInteger(size) || size <= 0) {
         return answer(new AppError('The upload did not say how large the video is. Reload the page and try again.', 400))
      }
      if (size > MAX_VIDEO_BYTES) return answer(new multer.MulterError('LIMIT_FILE_SIZE', file.fieldname))

      peek(file.stream, 12)
         .then(({ head, whole }) => {
            const kind = sniffVideo(head)
            if (!kind) {
               whole.destroy()
               throw new AppError('That file is not a video this site can show. Use MP4, MOV or WebM.', 400)
            }
            const counted = exactly(size)
            // A failure on either side ends the other: S3 must not be left
            // waiting, nor the sender writing to nobody.
            whole.on('error', (err) => counted.destroy(err))
            return adapter.save(
               {
                  stream: whole.pipe(counted),
                  // Under the extension of what it is, whatever it was called.
                  originalName: `${file.originalname.replace(/\.[^.]*$/, '') || 'video'}${kind.ext}`,
                  mimeType: kind.mimeType,
                  size,
               },
               { folder: VIDEO_FOLDER, visibility: 'public' }
            )
         })
         .then(
            (stored) => answer(null, stored),
            // Our own refusals as they are. Anything else is S3's (it said
            // no, or could not be reached): the admin's file is not at fault
            // and is told so; the operator gets the reason in the log.
            (err) => {
               if (err instanceof AppError) return answer(err)
               console.error('Video upload to S3 failed:', err?.name, err?.message)
               answer(new AppError('The video could not be stored just now. Try again in a moment.', 502))
            }
         )
   },
   // A request that fails after its video was stored takes the video with it.
   _removeFile(_req, file, cb) {
      const key = (file as { stored?: StoredFile }).stored?.key
      if (!key) return cb(null)
      storage()
         .remove(key)
         .then(
            () => cb(null),
            () => cb(null)
         )
   },
}

export const videoUploadMiddleware = multer({
   storage: videoToS3,
   defParamCharset: 'utf8',
   limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
   fileFilter: (_req, file, cb) => {
      // A first look, to turn away what is plainly something else before any
      // of it is read; what the file really is gets decided from its content.
      // By its declared type, or — some browsers send none for a .mov they
      // have no player for — by its name.
      const named = /\.(mp4|m4v|mov|webm)$/i.test(file.originalname)
      const untyped = !file.mimetype || file.mimetype === 'application/octet-stream'
      if (!VIDEO_TYPES.includes(file.mimetype) && !(untyped && named)) {
         return cb(new AppError('Upload the video as an MP4, MOV or WebM file', 400))
      }
      cb(null, true)
   },
}).single('file')

/**
 * POST /admin/v1/uploads/video  (field `size`, then one file in field `file`)
 *
 * Always public and always in the videos folder: the address it answers with
 * is what an inventory record stores as `videoUrl`, and the record accepts no
 * other (see `videoField`). By the time this runs the file is in S3.
 */
export const uploadVideo = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const stored = ((req as any).file as { stored?: StoredFile } | undefined)?.stored
      if (!stored) return next(new AppError('No video uploaded', 400))
      await recordAudit(req, {
         action: AUDIT_ACTIONS.CREATE,
         entityType: 'Upload',
         after: {
            driver: storage().name,
            visibility: 'public',
            folder: VIDEO_FOLDER,
            files: [{ key: stored.key, size: stored.size }],
         },
      })
      return sendResponse(res, 201, 'Video uploaded', { files: [stored] })
   }
)

/**
 * Surfaces multer's own errors as clean 400s instead of a generic 500 — and
 * the parser's: a body that is cut short or is not a form at all ("Unexpected
 * end of form", "Malformed part header") is the sender's mistake, not ours.
 * What the operating system refuses (a full disk) stays a server error.
 */
export const handleUploadErrors = (
   err: any,
   req: Request,
   _res: Response,
   next: NextFunction
) => {
   if (err instanceof multer.MulterError) {
      const message =
         err.code === 'LIMIT_FILE_SIZE'
            ? req.path.endsWith('/video')
               ? `The video is larger than ${MAX_VIDEO_BYTES / 1024 / 1024} MB`
               : 'File is too large'
            : err.code === 'LIMIT_FILE_COUNT'
              ? 'Too many files in one request'
              : err.message
      return next(new AppError(message, 400))
   }
   if (!(err instanceof AppError) && !err?.syscall) {
      return next(new AppError('The upload did not arrive whole. Try again.', 400))
   }
   next(err)
}

/**
 * POST /admin/v1/uploads
 *
 * `visibility=private` is what travel documents use: no permanent URL is ever
 * returned, only a key that must be exchanged for a short-lived signed link.
 */
export const uploadFiles = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const files = (req as any).files as Express.Multer.File[] | undefined
      if (!files?.length) return next(new AppError('No files uploaded', 400))

      const visibility: Visibility =
         req.body.visibility === 'private' ? 'private' : 'public'

      /**
       * Validate the folder here rather than letting the adapter's path guard
       * throw. That guard is the real backstop and does stop traversal, but it
       * surfaces as a 500 — a caller sending a bad folder deserves a 400 that
       * says what was wrong.
       */
      const folder = String(req.body.folder || 'misc')
      if (!/^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/i.test(folder)) {
         return next(
            new AppError(
               'folder may only contain letters, numbers, dashes, underscores and single slashes',
               400
            )
         )
      }
      // The videos folder is the video upload's alone: what a record accepts as
      // its video is "a file in that folder", and only that route checks that
      // the file is one.
      if (folder.toLowerCase() === VIDEO_FOLDER) {
         return next(new AppError('Videos are uploaded from the video box of the form', 400))
      }

      if (visibility === 'public') {
         const bad = files.find((f) => !IMAGE_TYPES.includes(f.mimetype))
         if (bad) {
            // A PDF in a public gallery is almost always a document filed in the
            // wrong place, and documents must not be publicly addressable.
            return next(
               new AppError(
                  'Only images can be uploaded publicly. Use visibility=private for documents.',
                  400
               )
            )
         }
         const tooBig = files.find((f) => f.size > MAX_IMAGE_BYTES)
         if (tooBig) return next(new AppError('Images must be under 8 MB', 400))
      }

      const adapter = storage()
      const stored = []
      for (const f of files) {
         stored.push(
            await adapter.save(
               {
                  buffer: f.buffer,
                  originalName: f.originalname,
                  mimeType: f.mimetype,
                  size: f.size,
               },
               { folder, visibility }
            )
         )
      }

      await recordAudit(req, {
         action: AUDIT_ACTIONS.CREATE,
         entityType: 'Upload',
         after: {
            driver: adapter.name,
            visibility,
            folder,
            files: stored.map((s) => ({ key: s.key, size: s.size })),
         },
      })

      return sendResponse(res, 201, `${stored.length} file(s) uploaded`, {
         files: stored,
      })
   }
)

/** Exchanges a private key for a short-lived link (§6.5, §14.4). */
export const getSignedLink = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const key = String(req.body.key || '')
      if (!key) return next(new AppError('key is required', 400))
      // 15 minutes, matching the export-link window in §14.4.
      const ttl = Math.min(Number(req.body.ttlSeconds) || 900, 900)

      await recordAudit(req, {
         action: AUDIT_ACTIONS.UPDATE,
         entityType: 'Upload',
         entityId: key,
         reason: 'signed download link issued',
      })

      return sendResponse(res, 200, 'Link generated', {
         url: await storage().signedUrl(key, ttl),
         expiresInSeconds: ttl,
      })
   }
)

/**
 * GET /admin/v1/files/:key?expires=&signature=
 *
 * Serves a private file for the local driver. Deliberately outside the session
 * guard — the signature IS the authorisation, which is what lets a link be
 * emailed to a customer without giving them a login. It expires, so it is not a
 * permanent public URL.
 *
 * With STORAGE_DRIVER=s3 this route is unused: presigned S3 URLs point at the
 * bucket directly.
 */
export const serveSignedFile = catchAsync(
   async (req: Request, res: Response, next: NextFunction) => {
      const key = decodeURIComponent(req.params.key)
      const expires = Number(req.query.expires)
      const signature = String(req.query.signature || '')

      if (!LocalDiskStorage.verify(key, expires, signature)) {
         return next(new AppError('This link is invalid or has expired', 403))
      }

      let file
      try {
         file = await storage().read(key)
      } catch {
         return next(new AppError('File not found', 404))
      }

      // Never render inline: an HTML or SVG payload served from our origin
      // would run in our security context.
      const name = safeDownloadName(String(req.query.name ?? ''))
      res.setHeader(
         'Content-Disposition',
         name ? `attachment; filename="${name}"` : 'attachment'
      )
      res.setHeader('X-Content-Type-Options', 'nosniff')
      if (file.mimeType) res.setHeader('Content-Type', file.mimeType)
      // An unhandled stream error is an uncaught exception. Headers may already
      // be out, so the connection is dropped rather than answered.
      file.stream.on('error', () => res.destroy())
      file.stream.pipe(res)
   }
)
