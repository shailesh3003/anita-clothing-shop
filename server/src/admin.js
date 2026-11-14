import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { pool } from './db.js'

const router = Router()
const newUser = z.object({ email: z.string().trim().email().max(254).transform(value => value.toLowerCase()), displayName: z.string().trim().min(1).max(100), password: z.string().min(12).max(128), role: z.enum(['ADMIN', 'STAFF']) })
const updateUser = z.object({ displayName: z.string().trim().min(1).max(100).optional(), role: z.enum(['ADMIN', 'STAFF']).optional(), isActive: z.boolean().optional() }).refine(value => Object.keys(value).length > 0)
const serialize = row => ({ id: row.id, email: row.email, displayName: row.display_name, role: row.role, isActive: row.is_active, createdAt: row.created_at })

router.get('/users', async (_req, res, next) => {
  try { const result = await pool.query('SELECT id, email, display_name, role, is_active, created_at FROM profiles ORDER BY created_at'); res.json({ users: result.rows.map(serialize) }) }
  catch (error) { next(error) }
})

router.post('/users', async (req, res, next) => {
  const parsed = newUser.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Provide a valid email, display name, role and password of at least 12 characters.' })
  try {
    const { email, displayName, password, role } = parsed.data
    const hash = await bcrypt.hash(password, 8)
    const result = await pool.query('INSERT INTO profiles (email, display_name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, email, display_name, role, is_active, created_at', [email, displayName, hash, role])
    res.status(201).json({ user: serialize(result.rows[0]) })
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'An account with that email already exists.' })
    next(error)
  }
})

router.patch('/users/:id', async (req, res, next) => {
  const parsed = updateUser.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Provide a display name, role or active status.' })
  const changes = parsed.data
  if (req.params.id === req.user.id && changes.isActive === false) return res.status(400).json({ error: 'You cannot deactivate your own account.' })
  try {
    const fields = []; const values = [req.params.id]
    if (changes.displayName !== undefined) { values.push(changes.displayName); fields.push(`display_name = $${values.length}`) }
    if (changes.role !== undefined) { values.push(changes.role); fields.push(`role = $${values.length}`) }
    if (changes.isActive !== undefined) { values.push(changes.isActive); fields.push(`is_active = $${values.length}`) }
    fields.push('updated_at = now()')
    const result = await pool.query(`UPDATE profiles SET ${fields.join(', ')} WHERE id = $1 RETURNING id, email, display_name, role, is_active, created_at`, values)
    if (!result.rowCount) return res.status(404).json({ error: 'User not found.' })
    res.json({ user: serialize(result.rows[0]) })
  } catch (error) { next(error) }
})

export default router
