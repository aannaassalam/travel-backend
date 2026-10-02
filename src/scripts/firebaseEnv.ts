/**
 * Prints the three environment properties a host with a small environment
 * limit needs for push, from a Firebase service-account key file:
 *
 *   npm run firebase:env -- /path/to/key.json
 *
 * Nothing is sent anywhere; paste the output into the host's settings. The
 * private key is printed on one line with its breaks as \n, which is what
 * push.service.ts expects.
 */
import fs from 'fs'

const file = process.argv[2]
if (!file) {
   console.error('usage: npm run firebase:env -- /path/to/service-account.json')
   process.exit(1)
}
const key = JSON.parse(fs.readFileSync(file, 'utf8'))
for (const [name, value] of [
   ['FIREBASE_PROJECT_ID', key.project_id],
   ['FIREBASE_CLIENT_EMAIL', key.client_email],
   ['FIREBASE_PRIVATE_KEY', String(key.private_key).replace(/\n/g, '\\n')],
]) {
   if (!value) {
      console.error(`${file} has no ${name.toLowerCase().replace('firebase_', '')}; is it a service-account key?`)
      process.exit(1)
   }
   console.log(`${name}=${value}`)
}
console.log(`\n(${Buffer.byteLength(String(key.private_key)) + 120} bytes in all)`)
