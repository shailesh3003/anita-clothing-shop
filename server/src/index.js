import express from 'express'
import session from 'express-session'
import pgSession from 'connect-pg-simple'
import rateLimit from 'express-rate-limit'
import { pool } from './db.js'
import authRoutes from './auth.js'
import adminRoutes from './admin.js'
import salesRoutes from './sales.js'
import dashboardRoutes from './dashboard.js'
import reportsRoutes from './reports.js'
import inventoryRoutes from './inventory.js'
import returnRoutes from './returns.js'
import { requireAdmin, requireAuth } from './middleware.js'
import { pathToFileURL } from 'node:url'

export function createApp() {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters')
  const app = express()
  const production = process.env.NODE_ENV === 'production'
  const PgStore = pgSession(session)
  app.disable('x-powered-by')
  if (production) app.set('trust proxy', 1)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains')
    next()
  })
  app.use(express.json({ limit: '128kb' }))
  app.use(session({ name: 'anita.sid', store: new PgStore({ pool, tableName: 'user_sessions', createTableIfMissing: false }), secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { httpOnly: true, secure: production, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000, path: '/' } }))
  app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many sign-in attempts. Please try again in a few minutes.' } }))
  app.use('/api/auth', authRoutes)
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))
  app.use('/api/admin', requireAuth, requireAdmin, adminRoutes)
  app.use('/api/sales', requireAuth, salesRoutes)
  app.use('/api/inventory', requireAuth, inventoryRoutes)
  app.use('/api/returns', requireAuth, requireAdmin, returnRoutes)
  app.use('/api/dashboard', requireAuth, dashboardRoutes)
  app.use('/api/reports', requireAuth, requireAdmin, reportsRoutes)
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }))
  app.use((error, _req, res, _next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'This request is too large. Reduce the number of item rows.' })
    console.error(error)
    res.status(500).json({ error: 'An unexpected server error occurred.' })
  })
  return app
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3001)
  const server = createApp().listen(port, () => console.log(`Anita Clothing Shop API listening on port ${port}`))
  async function shutdown() { server.close(); await pool.end(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
