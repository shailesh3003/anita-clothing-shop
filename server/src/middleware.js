import { pool } from './db.js'

export async function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Please sign in.' })
  try {
    const result = await pool.query('SELECT id, email, display_name, role, is_active FROM profiles WHERE id = $1', [req.session.userId])
    const user = result.rows[0]
    if (!user || !user.is_active) {
      return req.session.destroy(() => {
        res.clearCookie('anita.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' })
        res.status(401).json({ error: 'Your account is inactive. Contact an administrator.' })
      })
    }
    req.user = { id: user.id, email: user.email, displayName: user.display_name, role: user.role }
    next()
  } catch (error) { next(error) }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: 'Administrator access is required.' })
  next()
}
