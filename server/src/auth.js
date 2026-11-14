import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { pool } from './db.js'

const router = Router()
const credentials = z.object({ email: z.string().trim().email().max(254).transform(value => value.toLowerCase()), password: z.string().min(1).max(128) })
const publicUser = row => ({ id: row.id, email: row.email, displayName: row.display_name, role: row.role })

router.post('/login', async (req, res, next) => {
  const parsed = credentials.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email address and password.' })
  try {
    const { email, password } = parsed.data
    const result = await pool.query('SELECT id, email, display_name, password_hash, role, is_active FROM profiles WHERE email = $1', [email])
    const user = result.rows[0]
    if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'The email or password is incorrect.' })
    req.session.regenerate(error => {
      if (error) return next(error)
      req.session.userId = user.id
      req.session.save(saveError => saveError ? next(saveError) : res.json({ user: publicUser(user) }))
    })
  } catch (error) { next(error) }
})

router.get('/me', async (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Please sign in.' })
  try {
    const result = await pool.query('SELECT id, email, display_name, role, is_active FROM profiles WHERE id = $1', [req.session.userId])
    const user = result.rows[0]
    if (!user || !user.is_active) { return req.session.destroy(() => res.status(401).json({ error: 'Your account is inactive. Contact an administrator.' })) }
    res.json({ user: publicUser(user) })
  } catch (error) { next(error) }
})

router.post('/logout', (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error)
    res.clearCookie('anita.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' })
    res.status(204).end()
  })
})

export default router
