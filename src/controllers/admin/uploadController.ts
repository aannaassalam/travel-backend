import { NextFunction, Request, Response } from 'express'
import multer from 'multer'

import { AUDIT_ACTIONS } from '../../constants/admin.constants'
import { LocalDiskStorage, storage, Visibility } from '../../services/storage'
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
 * ponytail: memory buffering is fine at these sizes (8 MB images, 15 MB
 * documents). If large video ever arrives, switch to a streaming upload and
 * give the adapter a stream rather than a Buffer.
 */

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif']
const DOCUMENT_TYPES = [...IMAGE_TYPES, 'application/pdf']

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024

export const uploadMiddleware = multer({
   storage: multer.memoryStorage(),
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

/** Surfaces multer's own errors as clean 400s instead of a generic 500. */
export const handleUploadErrors = (
   err: any,
   _req: Request,
   _res: Response,
   next: NextFunction
) => {
   if (err instanceof multer.MulterError) {
      const message =
         err.code === 'LIMIT_FILE_SIZE'
            ? 'File is too large'
            : err.code === 'LIMIT_FILE_COUNT'
              ? 'Too many files in one request'
              : err.message
      return next(new AppError(message, 400))
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
