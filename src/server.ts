import 'dotenv/config'
import express, { NextFunction, Request, Response } from 'express'

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
