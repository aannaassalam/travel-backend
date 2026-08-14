/**
 * Assigns real photographs to every record in one vertical, alternating between
 * the supplied files.
 *
 *   npm run seed:images -- HOTEL  hotel-a.png hotel-b.png
 *   npm run seed:images -- FLIGHT flight-a.png flight-b.png
 *   npm run seed:images -- HOTEL  --relink        (re-point at what is already
 *                                                  stored, uploading nothing)
 *
 * `--relink` exists because the records and the files have separate lifetimes:
 * a catalogue re-seed clears the image URLs on every document while the
 * uploaded files sit untouched on disk. Without it the only way back is to
 * find the originals again, which may be long gone.
 *
 * Goes through the storage adapter rather than writing to disk directly, so it
 * behaves identically under STORAGE_DRIVER=s3.
 *
 * Clears ONLY the target vertical's folder. Running this for flights must not
 * delete the hotel photographs — each vertical owns its own folder, and a
 * blanket wipe of the storage root would quietly undo the previous run.
 *
 * Each file is stored once and shared by the records assigned to it; copying
 * the same bytes per record would just be waste.
 */
import dotenv from 'dotenv'
import fs from 'fs'
import mongoose from 'mongoose'
import path from 'path'

dotenv.config()

import { buildMongoUri } from '../config/db.config'
import { VERTICALS } from '../constants/domain.constants'
import { Hotel } from '../model/hotelModel'
import { Listing } from '../model/listingModel'
import { resolveLocalized } from '../model/shared.schema'
import { storage } from '../services/storage'

const MIME: Record<string, string> = {
   '.png': 'image/png',
   '.jpg': 'image/jpeg',
   '.jpeg': 'image/jpeg',
   '.webp': 'image/webp',
   '.avif': 'image/avif',
}

const run = async () => {
   const [verticalArg, ...files] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
   const vertical = String(verticalArg || '').toUpperCase()

   if (!Object.values(VERTICALS).includes(vertical as any)) {
      throw new Error(
         `First argument must be a vertical: ${Object.values(VERTICALS).join(', ')}`
      )
   }
   const relink = process.argv.includes('--relink')
   if (!relink) {
      if (!files.length) throw new Error('Pass at least one image path, or --relink')
      for (const f of files) {
         if (!fs.existsSync(f)) throw new Error(`No such file: ${f}`)
      }
   }

   // Matches the folder the admin uploader uses, so hand-uploaded and seeded
   // images land in the same place.
   const folder = vertical === VERTICALS.HOTEL ? 'hotels' : vertical.toLowerCase()

   await mongoose.connect(buildMongoUri())
   const adapter = storage()

   if (!relink && adapter.name === 'local') {
      const dir = path.join(
         path.resolve(process.env.STORAGE_ROOT || 'storage'),
         'public',
         folder
      )
      if (fs.existsSync(dir)) {
         const n = fs.readdirSync(dir).length
         fs.rmSync(dir, { recursive: true, force: true })
         console.log(`Cleared ${n} previous upload(s) from ${folder}/`)
      }
   } else if (!relink) {
      console.warn(
         `Storage driver is "${adapter.name}" — previous objects under ${folder}/ were NOT deleted. Clear them in the bucket.`
      )
   }

   const urls: string[] = []

   if (relink) {
      /**
       * The local directory is the source of filenames even under the S3
       * driver: migrate:s3 preserves the key (public/<folder>/<uuid>), so the
       * on-disk mirror still names every object correctly.
       */
      const dir = path.join(
         path.resolve(process.env.STORAGE_ROOT || 'storage'),
         'public',
         folder
      )
      const existing = fs.existsSync(dir)
         ? fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort()
         : []
      if (!existing.length) {
         throw new Error(`Nothing already stored under ${folder}/ to relink`)
      }

      const base = process.env.STORAGE_PUBLIC_URL || '/uploads'
      const isS3 = adapter.name === 's3'
      for (const f of existing) {
         // S3 keys carry the visibility prefix; the local route does not.
         const url = isS3
            ? `${base}/public/${folder}/${f}`
            : `${base}/${folder}/${f}`

         /**
          * Verify before writing. Relinking is guesswork about what the storage
          * layer holds, and a URL that 404s would replace a visible placeholder
          * with a broken image — strictly worse, and harder to notice.
          */
         if (/^https?:\/\//.test(url)) {
            const res = await fetch(url, { method: 'HEAD' })
            if (!res.ok) {
               throw new Error(
                  `${url} returned ${res.status} — refusing to link a file that is not there`
               )
            }
         }
         urls.push(url)
      }
      console.log(
         `Relinking ${existing.length} verified file(s) in ${folder}/ (${adapter.name})`
      )
   }

   for (const file of relink ? [] : files) {
      const buffer = await fs.promises.readFile(file)
      const stored = await adapter.save(
         {
            buffer,
            originalName: path.basename(file),
            mimeType: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            size: buffer.length,
         },
         { folder, visibility: 'public' }
      )
      if (!stored.url) throw new Error('Public upload returned no URL')
      urls.push(stored.url)
      console.log(`Uploaded ${path.basename(file)} -> ${stored.url}`)
   }

   // Stable order, so a re-run gives the same record the same picture rather
   // than reshuffling the catalogue.
   const records =
      vertical === VERTICALS.HOTEL
         ? await Hotel.find().sort({ _id: 1 })
         : await Listing.find({ vertical }).sort({ _id: 1 })

   if (!records.length) {
      console.warn(`\nNo ${vertical} records found — nothing to assign.`)
      await mongoose.disconnect()
      return
   }

   let i = 0
   for (const record of records) {
      const url = urls[i % urls.length]
      ;(record as any).images = [url]
      await record.save({ validateBeforeSave: false })
      const label = resolveLocalized(
         (record as any).name ?? (record as any).title
      )
      console.log(`  ${String(i + 1).padStart(2)}. ${label.padEnd(34)} -> ${url}`)
      i += 1
   }

   console.log(
      `\n${records.length} ${vertical} record(s) updated from ${urls.length} image(s). No other vertical touched.`
   )
   await mongoose.disconnect()
}

run().catch((e) => {
   console.error(e.message)
   process.exit(1)
})
