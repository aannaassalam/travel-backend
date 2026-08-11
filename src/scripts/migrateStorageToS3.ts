/**
 * One-off migration: uploads everything under <STORAGE_ROOT>/public to S3 under
 * the same key, then repoints the `/uploads/...` URLs already in MongoDB at the
 * bucket.
 *
 *   npm run migrate:s3 -- --dry     # print what would change, touch nothing
 *   npm run migrate:s3
 *
 * The existing S3 key is preserved (public/<folder>/<uuid>.ext) rather than
 * regenerated, so the DB fix is one string swap and a second run is a no-op.
 *
 * Only URLs whose file was actually uploaded get rewritten. A `/uploads/` URL
 * with no file on disk is left alone and reported — repointing it at a key that
 * does not exist would turn a broken image into a silently broken one.
 *
 * auditlogs is skipped deliberately: it records what happened, and rewriting
 * URLs inside it would falsify the trail.
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import dotenv from 'dotenv'
import fs from 'fs'
import mongoose from 'mongoose'
import path from 'path'

dotenv.config()

import { buildMongoUri } from '../config/db.config'

const MIME: Record<string, string> = {
   '.png': 'image/png',
   '.jpg': 'image/jpeg',
   '.jpeg': 'image/jpeg',
   '.webp': 'image/webp',
   '.avif': 'image/avif',
   '.pdf': 'application/pdf',
}

const SKIP_COLLECTIONS = ['auditlogs']
const LOCAL_PREFIX = '/uploads/'

const walk = (dir: string, base = dir): string[] =>
   fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
           const full = path.join(dir, e.name)
           return e.isDirectory() ? walk(full, base) : [path.relative(base, full)]
        })
      : []

/**
 * Collects the dotted paths of every string that needs rewriting. Returns paths
 * rather than a mutated document so the update is a targeted $set — a whole-doc
 * replace on 164 listings is a lot of blast radius for a URL change.
 */
export const collectRewrites = (
   node: unknown,
   urls: Map<string, string>,
   prefix = '',
   out: [string, string][] = []
): [string, string][] => {
   if (typeof node === 'string') {
      const next = urls.get(node)
      if (next && prefix) out.push([prefix, next])
   } else if (Array.isArray(node)) {
      node.forEach((v, i) => collectRewrites(v, urls, `${prefix}.${i}`, out))
   } else if (node && typeof node === 'object' && node.constructor === Object) {
      // Plain objects only — recursing into an ObjectId or Date would walk its
      // internals and produce dotted paths that mean nothing to Mongo.
      for (const [k, v] of Object.entries(node)) {
         collectRewrites(v, urls, prefix ? `${prefix}.${k}` : k, out)
      }
   }
   return out
}

const selfCheck = () => {
   const urls = new Map([['/uploads/a.png', 'https://cdn/public/a.png']])
   const doc = {
      _id: new mongoose.Types.ObjectId(),
      images: ['/uploads/a.png', '/uploads/missing.png'],
      nested: { hero: '/uploads/a.png', when: new Date(), n: 3 },
   }
   const got = collectRewrites(doc, urls)
   const expected = [
      ['images.0', 'https://cdn/public/a.png'],
      ['nested.hero', 'https://cdn/public/a.png'],
   ]
   if (JSON.stringify(got.sort()) !== JSON.stringify(expected)) {
      throw new Error(`self-check failed: ${JSON.stringify(got)}`)
   }
   console.log('self-check ok')
}

const run = async () => {
   const dry = process.argv.includes('--dry')
   if (process.argv.includes('--self-check')) return selfCheck()

   const bucket = process.env.AWS_PUBLIC_BUCKET_NAME
   const publicUrl = process.env.STORAGE_PUBLIC_URL
   if (!bucket) throw new Error('AWS_PUBLIC_BUCKET_NAME is required')
   if (!publicUrl || publicUrl.startsWith('/')) {
      throw new Error('STORAGE_PUBLIC_URL must be the absolute bucket/CDN URL')
   }

   const root = path.join(path.resolve(process.env.STORAGE_ROOT || 'storage'), 'public')
   const files = walk(root)
   if (!files.length) throw new Error(`No files under ${root}`)

   const client = new S3Client({
      region: process.env.AWS_REGION,
      credentials:
         process.env.AWS_ACCESS_KEY_ID && process.env.AWS_ACCESS_KEY_SECRET
            ? {
                 accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                 secretAccessKey: process.env.AWS_ACCESS_KEY_SECRET,
              }
            : undefined,
   })

   // Old URL -> new URL. Built from disk, so a DB URL with no file stays put.
   const urls = new Map<string, string>()

   console.log(`${dry ? '[dry] ' : ''}Uploading ${files.length} file(s) to ${bucket}\n`)
   for (const rel of files) {
      const key = `public/${rel.split(path.sep).join('/')}`
      if (!dry) {
         await client.send(
            new PutObjectCommand({
               Bucket: bucket,
               Key: key,
               Body: await fs.promises.readFile(path.join(root, rel)),
               ContentType:
                  MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream',
            })
         )
      }
      urls.set(`${LOCAL_PREFIX}${rel.split(path.sep).join('/')}`, `${publicUrl}/${key}`)
      console.log(`  ${key}`)
   }

   await mongoose.connect(buildMongoUri())
   const db = mongoose.connection.db

   let updated = 0
   const orphans = new Set<string>()

   for (const { name } of await db.listCollections().toArray()) {
      if (SKIP_COLLECTIONS.includes(name)) continue
      const collection = db.collection(name)
      let touched = 0

      for (const doc of await collection.find({}).toArray()) {
         // Every remaining `/uploads/` string is a file we did not upload.
         JSON.stringify(doc).match(/"\/uploads\/[^"]+"/g)?.forEach((m) => {
            const url = m.slice(1, -1)
            if (!urls.has(url)) orphans.add(url)
         })

         const rewrites = collectRewrites(doc, urls)
         if (!rewrites.length) continue
         if (!dry) {
            await collection.updateOne({ _id: doc._id }, { $set: Object.fromEntries(rewrites) })
         }
         touched += 1
         updated += rewrites.length
      }

      if (touched) console.log(`\n${name}: ${touched} document(s)`)
   }

   console.log(
      `\n${dry ? '[dry] would rewrite' : 'Rewrote'} ${updated} URL(s). ` +
         `Skipped: ${SKIP_COLLECTIONS.join(', ')}.`
   )
   if (orphans.size) {
      console.warn(
         `\n${orphans.size} URL(s) point at files missing from disk — left unchanged:`
      )
      orphans.forEach((u) => console.warn(`  ${u}`))
   }

   await mongoose.disconnect()
}

run().catch((e) => {
   console.error(e.message)
   process.exit(1)
})
