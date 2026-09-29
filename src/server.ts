import 'dotenv/config'
import dns from 'node:dns'
import net from 'node:net'
import express, { NextFunction, Request, Response } from 'express'

/**
 * Egress over IPv4 by default.
 *
 * Node 20+ resolves in "verbatim" order and then races both address families
 * (Happy Eyeballs, `autoSelectFamily`). On a dual-stack connection IPv6 usually
 * wins, so outbound calls leave from the machine's IPv6 address — which is NOT
 * the IPv4 that `curl ifconfig.me` reports, and not what anyone would think to
 * whitelist.
 *
 * That mattered here: a provider allow-listed merchant IPs, and every call was
 * arriving from a dynamic residential IPv6 prefix while the IPv4 sat unused.
 * Providers with IP allow-lists are common (payments, SMS, banking), so this is
 * an application-wide concern rather than a payment one, which is why it lives
 * at the entry point and runs before anything opens a socket.
 *
 * `ipv4first` only reorders the addresses that exist, so an IPv6-only network
 * still connects. Set EGRESS_IPV4_FIRST=false to opt out.
 */
if (process.env.EGRESS_IPV4_FIRST !== 'false') {
   dns.setDefaultResultOrder('ipv4first')
   net.setDefaultAutoSelectFamily?.(false)
}

import { RESPONSES } from './constants/constants'
import connectDb from './config/db.config'
import app from './app'
import { startScheduledJobs } from './services/scheduledJobs.service'

const PORT = process.env.PORT || 3001


// function errorHandler(
//    err: any,
//    _req: Request,
//    res: Response,
//    _next: NextFunction
// ) {
//    console.error(err)

//    res.status(500).json({
//       response: RESPONSES.ERROR,
//       message: err.message || 'Internal Server Error',
//    })
// }

async function bootstrap() {
   const dbConnection = await connectDb()
   

   // §6.1/§14.5/§5.1: cash release, passport purge, scheduled publishing.
   startScheduledJobs()

   const server = app.listen(PORT, () => {
      console.log(`Listening on PORT ${PORT}`)
   })

   server.on('error', (err) => {
      console.log(`Error: ${err}`)
   })

   const gracefulShutdown = async () => {
      console.log('Received shutdown signal. Shutting down Gracefully.')
      await dbConnection.disconnect()
      server.close(() => {
         console.log('HTTP server closed.')
         process.exit(1)
      })
   }

   process.on('SIGINT', gracefulShutdown)
   process.on('SIGTERM', gracefulShutdown)
}

bootstrap()
