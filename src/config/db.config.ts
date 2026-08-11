import { connect as _connect, Mongoose } from 'mongoose'

/**
 * Builds the connection string from MONGODB_URI + DATABASE_PASSWORD, so the
 * password is never stored inline in the URI. Supports both conventions:
 *
 *   mongodb+srv://user:<PASSWORD>@host/db   → placeholder is substituted
 *   mongodb+srv://user@host/db              → password is injected after the user
 *
 * A URI that already carries a real password is used as-is.
 *
 * Read at call time, not module load, so dotenv.config() has always run first.
 */
export const buildMongoUri = (
   uri = process.env.MONGODB_URI,
   password = process.env.DATABASE_PASSWORD
): string => {
   if (!uri) {
      throw new Error('MONGODB_URI is not defined in the environment variables')
   }

   if (uri.includes('<PASSWORD>')) {
      if (!password) {
         throw new Error(
            'MONGODB_URI contains <PASSWORD> but DATABASE_PASSWORD is not set'
         )
      }
      return uri.replace('<PASSWORD>', encodeURIComponent(password))
   }

   // `scheme://credentials@rest` — credentials carry no ':' when the password
   // is absent. Anything after the first '@' is host/db and is left alone.
   const match = /^(mongodb(?:\+srv)?:\/\/)([^@/]+)@(.+)$/.exec(uri)
   if (match && !match[2].includes(':')) {
      if (!password) {
         throw new Error(
            'MONGODB_URI has a username but no password, and DATABASE_PASSWORD is not set'
         )
      }
      return `${match[1]}${match[2]}:${encodeURIComponent(password)}@${match[3]}`
   }

   return uri
}

export default async function connectDb(): Promise<Mongoose> {
   try {
      const connect = await _connect(buildMongoUri())
      console.log(
         `MongoDB Connected: ${connect.connection.host}:${connect.connection.port}/${connect.connection.name}`
      )
      return connect
   } catch (err: any) {
      console.log(`Error: ${err.message}`)
      process.exit(1)
   }
}
