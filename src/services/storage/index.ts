import { LocalDiskStorage } from './localDisk.storage'
import { StorageAdapter } from './storage.types'

export * from './storage.types'
export { LocalDiskStorage } from './localDisk.storage'

/**
 * Picks the storage driver. Switching to S3 is `STORAGE_DRIVER=s3` plus the
 * bucket credentials — nothing else in the codebase changes, because every
 * caller goes through the StorageAdapter interface.
 */
let adapter: StorageAdapter | null = null

export const storage = (): StorageAdapter => {
   if (adapter) return adapter

   const driver = (process.env.STORAGE_DRIVER || 'local').toLowerCase()
   if (driver === 's3') {
      // Required lazily: the S3 module pulls in the AWS SDK and reads bucket
      // config at construction, and a local-driver install should not pay for
      // that or fail because a bucket is unset.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { S3Storage } = require('./s3.storage')
      adapter = new S3Storage() as StorageAdapter
   } else {
      adapter = new LocalDiskStorage()
   }
   return adapter!
}

/** Test hook — lets a spec swap the driver without touching the environment. */
export const __setStorage = (a: StorageAdapter | null) => {
   adapter = a
}
