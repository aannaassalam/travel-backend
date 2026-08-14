import cors from 'cors'
import express, { NextFunction, Request, Response } from 'express'
import cookieParser from 'cookie-parser'
import mongoSanitize from 'express-mongo-sanitize'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import morgan from 'morgan'
import xss from 'xss'

import globalErrorHandler from './controllers/errorController/errorController'
import adminV1Routes from './routes/admin/v1'
import v1Routes from './routes/v1'
import { PUBLIC_DIR, PUBLIC_URL_PREFIX } from './services/storage/localDisk.storage'
import AppError from './utils/appError'

const app = express()

// 1) GLOBAL Middleware
// Set security HTTP headers
app.use(helmet())

// Development Logging
if (process.env.NODE_ENV === 'development') {
   app.use(morgan('dev'))
}

/**
 * Explicit origin allow-list. `origin: '*'` on a credentialed API lets any site
 * a logged-in admin visits call this backend with his session.
 * ORIGIN accepts a comma-separated list: public site, admin subdomain.
 */
const allowedOrigins = (process.env.ORIGIN || '')
   .split(',')
   .map((o) => o.trim())
   .filter(Boolean)

/**
 * In development only, any loopback origin is allowed whatever its port.
 *
 * Next picks the next free port when its preferred one is taken, so a dev
 * frontend legitimately moves between 3000/3002/3003 on the same machine.
 * Pinning each one in ORIGIN means editing .env and restarting the API every
 * time that happens, and the failure it produces — every browser fetch blocked
 * while curl and server-side rendering both work — costs far more time to
 * diagnose than it should.
 *
 * Production is unaffected: there the allow-list is the only thing consulted,
 * and `origin: '*'` is never used on a credentialed API.
 */
const isDev = process.env.NODE_ENV !== 'production'
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

app.use(
   cors({
      origin(origin, callback) {
         // Same-origin/server-to-server requests send no Origin header.
         if (!origin) return callback(null, true)
         if (allowedOrigins.includes(origin)) return callback(null, true)
         if (isDev && LOOPBACK.test(origin)) return callback(null, true)
         /**
          * `false`, not `new Error(...)`. Throwing here hands the rejection to
          * the global error handler, which answers 500 — and outside
          * production that reply carries a stack trace with absolute server
          * paths, to an unauthenticated caller, on every request from any
          * origin. It also misreports a deliberate policy decision as a server
          * fault, so a misconfigured frontend port looks like a backend crash.
          *
          * Returning false omits `Access-Control-Allow-Origin` instead. The
          * browser blocks the read, which is exactly what the allow-list is
          * for, and the response stays a normal one.
          */
         return callback(null, false)
      },
      credentials: true,
      exposedHeaders: ['X-Message'],
   })
)

app.set('trust proxy', true)

// Body parser, reading data from body into req.body
// Sessions travel in an httpOnly cookie as well as the Authorization header,
// so the cookie has to be parsed before any guard looks for it.
app.use(cookieParser())

app.use(express.json({ limit: '100mb' }))
app.use(express.urlencoded({ extended: true, limit: '100mb' }))

// Data sanitization against NOSQL query injection
app.use(mongoSanitize())

// Data sanitization against XSS
app.use(sanitizeXSS)

// Serving static files
app.use(express.static(`${__dirname}/public`))

/**
 * Public uploads (gallery images) when STORAGE_DRIVER=local. Only the `public`
 * side of the storage root is exposed — private documents live in a sibling
 * directory that is never mounted and is only reachable through a signed link.
 *
 * nosniff + a download disposition on anything that is not an image, so an
 * uploaded SVG or HTML file cannot execute in our origin.
 */
app.use(
   PUBLIC_URL_PREFIX,
   express.static(PUBLIC_DIR, {
      index: false,
      setHeaders: (res, filePath) => {
         res.setHeader('X-Content-Type-Options', 'nosniff')
         /**
          * Helmet sets Cross-Origin-Resource-Policy: same-origin globally, which
          * stops the admin panel (a different origin from the API) from
          * embedding these images at all. Relaxed HERE ONLY — the rest of the
          * API keeps the strict policy, and private documents are not served
          * from this directory.
          */
         res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
         if (!/\.(jpe?g|png|webp|avif)$/i.test(filePath)) {
            res.setHeader('Content-Disposition', 'attachment')
         }
      },
   })
)

// Test middleware
app.use((req: Request, res: Response, next: NextFunction) => {
   ;(req as any).requestTime = new Date().toISOString()
   next()
})

// 3) Routes
app.use(
   '/api/v1',
   rateLimit({
      max: 300,
      windowMs: 15 * 60 * 1000,
      standardHeaders: true,
      legacyHeaders: false,
      message: { message: 'Too many requests, please try again later' },
   }),
   v1Routes
)

/**
 * §2.1: distinct admin surface. Deliberately mounted separately from /api/v1
 * so the two never share a guard, a DTO or a response object.
 *
 * §14.1: this should additionally sit behind Cloudflare Access (or equivalent)
 * plus an IP allow-list at the edge — an unauthenticated visitor should not be
 * able to reach the admin login page at all. That is infrastructure, not code;
 * the application-layer controls here are the second line, not the first.
 */
app.use(
   '/admin/v1',
   rateLimit({
      max: 600,
      windowMs: 15 * 60 * 1000,
      standardHeaders: true,
      legacyHeaders: false,
      message: { message: 'Too many requests, please try again later' },
   }),
   (req: Request, res: Response, next: NextFunction) => {
      res.set('X-Robots-Tag', 'noindex, nofollow')
      next()
   },
   adminV1Routes
)

/**
 * Load balancer health check. Must be registered here, before the catch-all —
 * anything added to `app` after bootstrap runs lands behind the 404 handler and
 * is unreachable.
 */
app.get('/health', (_req: Request, res: Response) =>
   res.status(200).json({ status: 'ok' })
)

app.all('*', (req: Request, res: Response, next: NextFunction) => {
   next(new AppError(`Can't find ${req.originalUrl} on the Server!`, 404))
})

app.use(globalErrorHandler)

// Middleware to sanitize XSS
function sanitizeXSS(req: Request, res: Response, next: NextFunction) {
   for (const key in req.body) {
      if (typeof req.body[key] === 'string') {
         req.body[key] = xss(req.body[key])
      }
   }
   next()
}

export default app
