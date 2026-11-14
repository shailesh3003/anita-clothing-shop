import { saleNetProfitSelect } from './profit.js'
import { Router } from 'express'
import { z } from 'zod'
import { pool } from './db.js'
import { requireAdmin } from './middleware.js'
import { calculateSaleTotal, getSaleItems, insertSaleItems, saleItemsSchema } from './sale-items.js'
import { reconcileSaleStock, stockError } from './inventory-stock.js'

const router = Router()
const paymentMethod = z.enum(['CASH', 'UPI', 'CARD', 'OTHER'])
const validDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`)
  return value.slice(0, 4) !== '0000' && !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
}, 'Enter a real calendar date.')
const description = z.string().trim().max(250, 'Description must be 250 characters or fewer.').optional().default('').transform(value => value || null)
const createSale = z.object({ saleDate: validDate, items: saleItemsSchema, paymentMethod, description, idempotencyKey: z.string().uuid() })
const editSale = z.object({ saleDate: validDate, items: saleItemsSchema.optional(), paymentMethod, description, reason: z.string().trim().min(3, 'Enter a reason for this correction.').max(300) })
const voidSale = z.object({ reason: z.string().trim().min(3, 'Enter a reason for voiding this sale.').max(300) })
const listQuery = z.object({ from: validDate.optional(), to: validDate.optional(), page: z.coerce.number().int().min(1).max(100000).default(1) }).refine(value => !value.from || !value.to || value.from <= value.to, { message: 'Start date must be on or before end date.' })
const formatSale = (row, isAdmin) => ({
  id: row.id,
  saleDate: row.sale_date,
  totalAmount: row.total_amount,
  paymentMethod: row.payment_method,
  description: row.description,
  createdBy: row.created_by,
  createdByName: row.created_by_name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
  updatedByName: row.updated_by_name,
  voidedAt: row.voided_at,
  voidedBy: row.voided_by,
  voidedByName: row.voided_by_name,
  items: (row.items || []).map(item => { if (isAdmin) return item; const safe = { ...item }; delete safe.unitCost; return safe }),
  hasReturns: row.has_returns,
  isExchangeReplacement: row.is_exchange_replacement,
  refundedAmount: row.refunded_amount,
  ...(isAdmin ? { grossProfit: row.voided_at ? null : row.gross_profit } : {}),
})
const saleSelect = `
  SELECT s.id, to_char(s.sale_date, 'YYYY-MM-DD') AS sale_date, s.total_amount::text AS total_amount,
         s.payment_method, s.description, s.created_by, creator.display_name AS created_by_name,
         s.created_at, s.updated_at, s.updated_by, editor.display_name AS updated_by_name,
         s.voided_at, s.voided_by, voider.display_name AS voided_by_name,
         COALESCE((SELECT json_agg(json_build_object(
           'id',si.id,'returnedQuantity',(SELECT coalesce(sum(ri.quantity),0) FROM sale_return_items ri WHERE ri.sale_item_id=si.id),
           'itemName', si.item_name, 'productId', si.product_id, 'quantity', si.quantity, 'unitPrice', si.unit_price::text,
           'unitCost', si.unit_cost::text, 'subtotal', (si.unit_price * si.quantity)::numeric(12, 2)::text
         ) ORDER BY si.line_number) FROM sale_items si WHERE si.sale_id = s.id), '[]'::json) AS items,
         EXISTS(SELECT 1 FROM sale_returns r WHERE r.sale_id=s.id) AS has_returns,
         EXISTS(SELECT 1 FROM sale_returns r WHERE r.replacement_sale_id=s.id) AS is_exchange_replacement,
         (SELECT coalesce(sum(r.credit_amount),0)::text FROM sale_returns r WHERE r.sale_id=s.id) AS refunded_amount,
         ${saleNetProfitSelect}
    FROM sales s
    JOIN profiles creator ON creator.id = s.created_by
    LEFT JOIN profiles editor ON editor.id = s.updated_by
    LEFT JOIN profiles voider ON voider.id = s.voided_by`

router.post('/', async (req, res, next) => {
  const parsed = createSale.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Check the sale details and try again.' })
  const { saleDate, items, paymentMethod: method, description: note, idempotencyKey } = parsed.data
  let totalAmount
  try { totalAmount = calculateSaleTotal(items) }
  catch (error) { return res.status(400).json({ error: error.message }) }
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN')
    const inserted = await client.query(
      `INSERT INTO sales (sale_date, total_amount, payment_method, description, created_by, idempotency_key)
       VALUES ($1, $2::numeric, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [saleDate, totalAmount, method, note, req.user.id, idempotencyKey],
    )
    const duplicate = !inserted.rowCount
    const duplicateSale = duplicate ? await client.query('SELECT id FROM sales WHERE idempotency_key = $1 AND created_by = $2', [idempotencyKey, req.user.id]) : null
    const saleId = inserted.rows[0]?.id || duplicateSale?.rows[0]?.id
    if (!saleId) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'This submission key cannot be reused. Refresh the form and try again.' })
    }
    if (!duplicate) {
      if (items.some(item => !item.productId)) throw stockError('Choose an inventory product for every new sale item.', 400)
      await reconcileSaleStock(client, [], items, { actorId: req.user.id, saleId, kind: 'SALE', reason: 'Sale recorded' })
      await insertSaleItems(client, saleId, items)
    }
    const result = await client.query(`${saleSelect} WHERE s.id = $1`, [saleId])
    if (!duplicate) {
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, affected_table, affected_record_id, change_metadata)
         VALUES ($1, 'SALE_CREATED', 'sales', $2, $3::jsonb)`,
        [req.user.id, result.rows[0].id, JSON.stringify({ saleDate, totalAmount, paymentMethod: method, description: note, items })],
      )
    }
    await client.query('COMMIT')
    res.status(duplicate ? 200 : 201).json({ sale: formatSale(result.rows[0], req.user.role === 'ADMIN'), duplicate })
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    if (error.inventoryError) return res.status(error.status).json({ error: error.message })
    next(error)
  } finally { client?.release() }
})

router.get('/', async (req, res, next) => {
  const parsed = listQuery.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Check the date filter.' })
  const { from = null, to = null, page } = parsed.data
  const pageSize = 25
  const offset = (page - 1) * pageSize
  const creatorFilter = req.user.role === 'ADMIN' ? null : req.user.id
  try {
    const count = await pool.query(
      `SELECT count(*)::int AS total FROM sales s
        WHERE ($1::date IS NULL OR s.sale_date >= $1)
          AND ($2::date IS NULL OR s.sale_date <= $2)
          AND ($3::uuid IS NULL OR s.created_by = $3)`,
      [from, to, creatorFilter],
    )
    const rows = await pool.query(
      `${saleSelect}
        WHERE ($1::date IS NULL OR s.sale_date >= $1)
          AND ($2::date IS NULL OR s.sale_date <= $2)
          AND ($3::uuid IS NULL OR s.created_by = $3)
        ORDER BY s.sale_date DESC, s.created_at DESC, s.id DESC
        LIMIT $4 OFFSET $5`,
      [from, to, creatorFilter, pageSize, offset],
    )
    const total = count.rows[0].total
    res.json({ sales: rows.rows.map(row => formatSale(row, req.user.role === 'ADMIN')), page, pageSize, total, totalPages: Math.ceil(total / pageSize) })
  } catch (error) { next(error) }
})

router.patch('/:id', requireAdmin, async (req, res, next) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: 'Sale ID is invalid.' })
  const parsed = editSale.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Check the correction details.' })
  const { saleDate, items, paymentMethod: method, description: note, reason } = parsed.data
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN')
    const current = await client.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [req.params.id])
    if (!current.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Sale not found.' }) }
    const before = current.rows[0]
    if (before.voided_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Voided sales cannot be edited.' }) }
    const linkedReturn = await client.query('SELECT 1 FROM sale_returns WHERE sale_id=$1 OR replacement_sale_id=$1 LIMIT 1',[req.params.id])
    if (linkedReturn.rowCount) throw stockError('Sales linked to returns or exchanges cannot be edited or voided.')
    const beforeItems = await getSaleItems(client, req.params.id)
    let totalAmount = before.total_amount
    if (items) {
      try { totalAmount = calculateSaleTotal(items) }
      catch (error) { await client.query('ROLLBACK'); return res.status(400).json({ error: error.message }) }
    } else if (beforeItems.length) {
      totalAmount = before.total_amount
    }
    const updated = await client.query(
      `UPDATE sales SET sale_date = $2, total_amount = $3::numeric, payment_method = $4, description = $5,
                        updated_by = $6, updated_at = now()
        WHERE id = $1 RETURNING id`,
      [req.params.id, saleDate, totalAmount, method, note, req.user.id],
    )
    if (items) {
      if (beforeItems.some(item => item.productId) && items.some(item => !item.productId)) throw stockError('Tracked sale items must stay linked to inventory.', 400)
      await reconcileSaleStock(client, beforeItems, items, { actorId: req.user.id, saleId: req.params.id, kind: 'CORRECTION', reason })
      await client.query('DELETE FROM sale_items WHERE sale_id = $1', [req.params.id])
      await insertSaleItems(client, req.params.id, items)
    }
    const afterItems = items || beforeItems
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, affected_table, affected_record_id, change_metadata)
       VALUES ($1, 'SALE_UPDATED', 'sales', $2, $3::jsonb)`,
      [req.user.id, req.params.id, JSON.stringify({ reason, before: { saleDate: before.sale_date, totalAmount: before.total_amount, paymentMethod: before.payment_method, description: before.description, items: beforeItems }, after: { saleDate, totalAmount, paymentMethod: method, description: note, items: afterItems } })],
    )
    const result = await client.query(`${saleSelect} WHERE s.id = $1`, [updated.rows[0].id])
    await client.query('COMMIT')
    res.json({ sale: formatSale(result.rows[0], req.user.role === 'ADMIN') })
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    if (error.inventoryError) return res.status(error.status).json({ error: error.message })
    next(error)
  } finally { client?.release() }
})

router.post('/:id/void', requireAdmin, async (req, res, next) => {
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: 'Sale ID is invalid.' })
  const parsed = voidSale.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Enter a reason for voiding this sale.' })
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN')
    const current = await client.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [req.params.id])
    if (!current.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Sale not found.' }) }
    const before = current.rows[0]
    if (before.voided_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This sale has already been voided.' }) }
    const linkedReturn = await client.query('SELECT 1 FROM sale_returns WHERE sale_id=$1 OR replacement_sale_id=$1 LIMIT 1',[req.params.id])
    if (linkedReturn.rowCount) throw stockError('Sales linked to returns or exchanges cannot be edited or voided.')
    const beforeItems = await getSaleItems(client, req.params.id)
    await reconcileSaleStock(client, beforeItems, [], { actorId: req.user.id, saleId: req.params.id, kind: 'VOID', reason: parsed.data.reason })
    await client.query('UPDATE sales SET voided_at = now(), voided_by = $2, updated_by = $2, updated_at = now() WHERE id = $1', [req.params.id, req.user.id])
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, affected_table, affected_record_id, change_metadata)
       VALUES ($1, 'SALE_VOIDED', 'sales', $2, $3::jsonb)`,
      [req.user.id, req.params.id, JSON.stringify({ reason: parsed.data.reason, before: { saleDate: before.sale_date, totalAmount: before.total_amount, paymentMethod: before.payment_method, description: before.description, items: beforeItems }, after: { voided: true } })],
    )
    const result = await client.query(`${saleSelect} WHERE s.id = $1`, [req.params.id])
    await client.query('COMMIT')
    res.json({ sale: formatSale(result.rows[0], req.user.role === 'ADMIN') })
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    if (error.inventoryError) return res.status(error.status).json({ error: error.message })
    next(error)
  } finally { client?.release() }
})

export default router
