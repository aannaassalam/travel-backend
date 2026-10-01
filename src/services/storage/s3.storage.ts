import {
   DeleteObjectCommand,
   GetObjectCommand,
   PutObjectCommand,
   S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import crypto from 'crypto'
import path from 'path'

import {
   safeDownloadName,
   StorageAdapter,
   StoredFile,
   UploadInput,
   Visibility,
} from './storage.types'

/**
 * S3 storage. Enable with STORAGE_DRIVER=s3.
 *
 * ponytail: written against the SDK already in package.json, but NOT yet run
 * against a real bucket — there is no AWS account wired up. Treat the first
 * deploy with this driver as the test: upload one image, one document, and
 * confirm the private one 403s without a signature.
 *
 * Bucket policy matters as much as this code. The bucket must block public
 * access entirely; "public" here means served through CloudFront or a
 * public-read prefix you configure, not an open bucket. Private objects rely on
 * presigned URLs, which is the same contract the local driver imitates.
 */
export class S3Storage implements StorageAdapter {
   readonly name = 's3'
   private client: S3Client
   private bucket: string
   private publicBaseUrl?: string

   constructor() {
      this.bucket = process.env.AWS_PUBLIC_BUCKET_NAME || ''
      if (!this.bucket) {
         throw new Error('AWS_PUBLIC_BUCKET_NAME is required when STORAGE_DRIVER=s3')
      }
      this.publicBaseUrl = process.env.STORAGE_PUBLIC_URL
      this.client = new S3Client({
         region: process.env.AWS_REGION,
         credentials:
            process.env.AWS_ACCESS_KEY_ID && process.env.AWS_ACCESS_KEY_SECRET
               ? {
                    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                    secretAccessKey: process.env.AWS_ACCESS_KEY_SECRET,
                 }
               : // Falls back to the instance role / shared config, which is the
                 // better option in production than long-lived keys in env vars.
                 undefined,
      })
   }

   private objectKey(visibility: Visibility, folder: string, originalName: string) {
      const ext = path.extname(originalName).toLowerCase()
      const safeExt = /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : ''
      const safeFolder = folder.replace(/[^a-z0-9/_-]/gi, '')
      return `${visibility}/${safeFolder}/${crypto.randomUUID()}${safeExt}`
   }

   async save(
      input: UploadInput,
      opts: { folder: string; visibility: Visibility }
   ): Promise<StoredFile> {
      const key = this.objectKey(opts.visibility, opts.folder, input.originalName)
      await this.client.send(
         new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: input.buffer,
            ContentType: input.mimeType,
         })
      )
      return {
         key,
         url:
            opts.visibility === 'public' && this.publicBaseUrl
               ? `${this.publicBaseUrl}/${key}`
               : undefined,
         originalName: input.originalName,
         mimeType: input.mimeType,
         size: input.size,
         visibility: opts.visibility,
      }
   }

   async signedUrl(key: string, ttlSeconds: number, downloadName?: string): Promise<string> {
      const name = safeDownloadName(downloadName)
      return getSignedUrl(
         this.client,
         new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
            // Always an attachment: a document must download, never render.
            ResponseContentDisposition: name ? `attachment; filename="${name}"` : 'attachment',
         }),
         { expiresIn: ttlSeconds }
      )
   }

   async read(key: string) {
      const out = await this.client.send(
         new GetObjectCommand({ Bucket: this.bucket, Key: key })
      )
      return {
         stream: out.Body as NodeJS.ReadableStream,
         mimeType: out.ContentType,
      }
   }

   async remove(key: string) {
      await this.client.send(
         new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
      )
   }
}
