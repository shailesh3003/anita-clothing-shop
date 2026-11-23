import { Router } from 'express'
import { z } from 'zod'
import { pool } from './db.js'
import { requireAdmin } from './middleware.js'
import { recordMovement, stockError, weightedCost } from './inventory-stock.js'
import { validDate } from './report-period.js'

const router = Router()
const quantity = z.number().int().min(0).max(999999999)
const uuid = z.string().uuid().transform(value => value.toLowerCase())
const productFields = {
  sku: z.string().trim().toUpperCase().min(1).max(50),
  name: z.string().trim().min(1).max(100),
  size: z.string().trim().max(30).default(''),
  color: z.string().trim().max(40).default(''),
  barcode: z.string().trim().max(80).optional().default('').transform(value => value || null),
  purchaseRate: z.string().regex(/^\d{1,10}(?:\.\d{1,6})?$/),
  reorderLevel: quantity,
}
const purchaseDate = z.string().refine(validDate,'Enter a valid purchase date.')
const createProduct = z.object({ ...productFields, openingStock: quantity, requestKey: uuid, purchaseDate: purchaseDate.optional() })
const editProduct = z.object({ ...productFields, isActive: z.boolean(), version: z.number().int().positive() })
const adjustment = z.object({ purchaseDate: purchaseDate.optional(), purchaseRate: z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/).optional(), kind: z.enum(['RECEIPT','DAMAGE','COUNT']), quantity, expectedVersion: z.number().int().positive(), reason: z.string().trim().min(3).max(300), requestKey: uuid })
const lifecycleAction = z.object({ reason: z.string().trim().min(3).max(300), version: z.number().int().positive() })
const listQuery = z.object({ q: z.string().trim().max(100).default(''), status: z.enum(['active','archived','all','low','removed']).default('active'), page: z.coerce.number().int().min(1).max(100000).default(1) })
const serialize = row => ({ id: row.id, sku: row.sku, name: row.name, size: row.size, color: row.color, barcode: row.barcode || '', isRemoved: !!row.removed_at, removedAt: row.removed_at, removalReason: row.removal_reason, purchaseRate: row.purchase_cost, lastPurchaseDate: row.last_purchase_date ?? null, stock: row.stock, reorderLevel: row.reorder_level, isActive: row.is_active, version: row.version, grossProfit: row.gross_profit || '0.00', missingCostUnits: Number(row.missing_cost_units || 0), damagedReturns: Number(row.damaged_returns || 0), soldQuantity: Number(row.sold_quantity || 0) })
const validId = (req, res, next) => {
  const parsed = uuid.safeParse(req.params.id)
  if (!parsed.success) return res.status(400).json({ error: 'Product ID is invalid.' })
  req.params.id = parsed.data
  next()
}

async function validatePurchaseDate(client,value){
  if(!value)throw stockError('Choose the actual stock purchase date.',400)
  const today=(await client.query("SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS date")).rows[0].date
  if(value>today)throw stockError('Purchase date cannot be in the future.',400)
}

async function transaction(res, next, operation) {
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN')
    const { status = 200, body } = await operation(client)
    await client.query('COMMIT')
    res.status(status).json(body)
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    if (error.inventoryError) return res.status(error.status).json({ error: error.message })
    if (error.code === '23505') return res.status(409).json({ error: 'This SKU or barcode already exists. Use a unique code.' })
    next(error)
  } finally { client?.release() }
}

router.get('/summary', requireAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query(`SELECT
      count(*)::int AS "productCount",
      coalesce(sum(stock),0)::text AS "availableUnits",
      count(*) FILTER (WHERE is_active AND stock <= reorder_level)::int AS "lowStockCount",
      count(*) FILTER (WHERE is_active AND stock = 0)::int AS "outOfStockCount",
      round(coalesce(sum(stock * purchase_cost) FILTER (WHERE purchase_cost IS NOT NULL),0),2)::text AS "stockValue",
      coalesce(sum(stock) FILTER (WHERE purchase_cost IS NULL),0)::text AS "missingCostUnits"
      FROM inventory_products WHERE removed_at IS NULL`)
    res.json({ ...result.rows[0], asOf: new Date().toISOString() })
  } catch (error) { next(error) }
})

router.get('/', async (req, res, next) => {
  const parsed = listQuery.safeParse(req.query)
  if (!parsed.success) return res.status(400).json({ error: 'Check the inventory search and filters.' })
  const { q, status, page } = parsed.data
  const rateSearch = req.user.role === 'ADMIN' && /^\d{1,10}(?:\.\d{1,6})?$/.test(q) ? q : null
  if (status === 'removed' && req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Administrator access is required.' })
  try {
    const conditions = `WHERE (position(lower($1) in lower(p.name || ' ' || p.sku || ' ' || p.size || ' ' || p.color || ' ' || coalesce(p.barcode,''))) > 0
      OR ($4::numeric IS NOT NULL AND round(p.purchase_cost,2) = round($4::numeric,2)))
      AND (($2 = 'removed' AND p.removed_at IS NOT NULL) OR ($2 <> 'removed' AND p.removed_at IS NULL))
      AND ($2 IN ('all','removed') OR ($2 = 'archived' AND NOT p.is_active) OR ($2 IN ('active','low') AND p.is_active))
      AND ($2 <> 'low' OR p.stock <= p.reorder_level)`
    const result = await pool.query(
      `SELECT p.*, (SELECT coalesce(sum(si.quantity),0)::text FROM sale_items si JOIN sales s ON s.id=si.sale_id
        WHERE si.product_id=p.id AND s.voided_at IS NULL)::bigint - (SELECT coalesce(sum(ri.quantity),0) FROM sale_return_items ri JOIN sale_items si ON si.id=ri.sale_item_id WHERE si.product_id=p.id) AS sold_quantity,
        (SELECT round(coalesce(sum((si.unit_price-si.unit_cost)*si.quantity),0),2)::text FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.product_id=p.id AND s.voided_at IS NULL AND si.unit_cost IS NOT NULL)::numeric - (SELECT round(coalesce(sum(ri.quantity*(ri.unit_refund-CASE WHEN ri.condition='SELLABLE' THEN ri.unit_cost ELSE 0 END)),0),2) FROM sale_return_items ri JOIN sale_items si ON si.id=ri.sale_item_id WHERE si.product_id=p.id AND ri.unit_cost IS NOT NULL) AS gross_profit,
        (SELECT coalesce(sum(si.quantity),0)::text FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.product_id=p.id AND s.voided_at IS NULL AND si.unit_cost IS NULL) AS missing_cost_units,
        (SELECT coalesce(sum(ri.quantity),0)::text FROM sale_return_items ri JOIN sale_items si ON si.id=ri.sale_item_id WHERE si.product_id=p.id AND ri.condition='DAMAGED') AS damaged_returns,
        (SELECT to_char(max(m.purchase_date),'YYYY-MM-DD') FROM inventory_movements m WHERE m.product_id=p.id) AS last_purchase_date,
        count(*) OVER()::int AS total FROM inventory_products p ${conditions}
        ORDER BY lower(p.name),p.sku LIMIT 25 OFFSET $3`, [q, status, (page - 1) * 25, rateSearch],
    )
    const total = result.rows[0]?.total || 0
    res.json({ products: result.rows.map(row => { const product = serialize(row); if (req.user.role !== 'ADMIN') { delete product.purchaseRate; delete product.grossProfit; delete product.missingCostUnits } return product }), page, total, totalPages: Math.ceil(total / 25) })
  } catch (error) { next(error) }
})

router.post('/', requireAdmin, async (req, res, next) => {
  const parsed = createProduct.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Check the product details. Use a unique SKU, a valid purchase rate and whole stock quantities.' })
  const data = parsed.data
  await transaction(res, next, async client => {
    // Serialize retries even when the first response is lost.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [data.requestKey])
    const existing = await client.query('SELECT * FROM inventory_products WHERE create_request_key=$1', [data.requestKey])
    if (existing.rowCount) {
      if (existing.rows[0].created_by !== req.user.id) throw stockError('This request key cannot be reused.')
      return { body: { product: serialize(existing.rows[0]), duplicate: true } }
    }
    if(data.openingStock>0 || data.purchaseDate)await validatePurchaseDate(client,data.purchaseDate)
    const inserted = await client.query(
      `INSERT INTO inventory_products (sku,name,size,color,barcode,purchase_cost,reorder_level,create_request_key,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [data.sku,data.name,data.size,data.color,data.barcode,data.purchaseRate,data.reorderLevel,data.requestKey,req.user.id],
    )
    await recordMovement(client, inserted.rows[0], data.openingStock, { kind: 'OPENING', actorId: req.user.id, reason: 'Opening physical stock', purchaseDate:data.openingStock>0?data.purchaseDate:null })
    await client.query("INSERT INTO audit_logs (actor_id,action,affected_table,affected_record_id,change_metadata) VALUES ($1,'PRODUCT_CREATED','inventory_products',$2,$3::jsonb)", [req.user.id,inserted.rows[0].id,JSON.stringify(data)])
    const product = await client.query('SELECT * FROM inventory_products WHERE id=$1', [inserted.rows[0].id])
    return { status: 201, body: { product: serialize(product.rows[0]), duplicate: false } }
  })
})

router.patch('/:id', requireAdmin, validId, async (req, res, next) => {
  const parsed = editProduct.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Check the product details. Use a unique SKU, a valid purchase rate and whole stock quantities.' })
  const data = parsed.data
  await transaction(res, next, async client => {
    const current = await client.query('SELECT * FROM inventory_products WHERE id=$1 FOR UPDATE', [req.params.id])
    if (!current.rowCount) throw stockError('Product not found.', 404)
    if (current.rows[0].removed_at) throw stockError('Restore this removed item before editing it.')
    if (current.rows[0].version !== data.version) throw stockError('Stock or product details changed. Refresh and try again.')
    const result = await client.query(`UPDATE inventory_products SET sku=$2,name=$3,size=$4,color=$5,barcode=$6,purchase_cost=$7,reorder_level=$8,is_active=$9,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id,data.sku,data.name,data.size,data.color,data.barcode,data.purchaseRate,data.reorderLevel,data.isActive])
    await client.query("INSERT INTO audit_logs (actor_id,action,affected_table,affected_record_id,change_metadata) VALUES ($1,'PRODUCT_UPDATED','inventory_products',$2,$3::jsonb)", [req.user.id,req.params.id,JSON.stringify({ before: serialize(current.rows[0]), after: serialize(result.rows[0]) })])
    return { body: { product: serialize(result.rows[0]) } }
  })
})

router.post('/:id/adjustments', requireAdmin, validId, async (req, res, next) => {
  const parsed = adjustment.safeParse(req.body)
  if (!parsed.success || (parsed.data.kind !== 'COUNT' && parsed.data.quantity === 0)) return res.status(400).json({ error: 'Enter a whole quantity and a reason of at least 3 characters.' })
  const data = parsed.data
  await transaction(res, next, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [data.requestKey])
    const existing = await client.query('SELECT * FROM inventory_movements WHERE request_key=$1', [data.requestKey])
    if (existing.rowCount) {
      if (existing.rows[0].product_id !== req.params.id || existing.rows[0].actor_id !== req.user.id) throw stockError('This request key cannot be reused.')
      return { body: { duplicate: true } }
    }
    const current = await client.query('SELECT * FROM inventory_products WHERE id=$1 FOR UPDATE', [req.params.id])
    if (!current.rowCount) throw stockError('Product not found.', 404)
    const product = current.rows[0]
    if (product.removed_at) throw stockError('Restore this removed item before adjusting stock.')
    if (product.version !== data.expectedVersion) throw stockError('Stock or product details changed. Refresh and try again.')
    if (!product.is_active) throw stockError('Restore this archived product before adjusting stock.')
    const delta = data.kind === 'COUNT' ? data.quantity - product.stock : data.quantity * (data.kind === 'DAMAGE' ? -1 : 1)
    if (data.kind === 'RECEIPT' && data.purchaseRate === undefined) throw stockError('Enter the supplier purchase rate for this delivery.', 400)
    if (data.kind === 'RECEIPT') await validatePurchaseDate(client,data.purchaseDate)
    if (data.kind === 'RECEIPT' && product.stock > 0 && product.purchase_cost == null) throw stockError('Enter the purchase rate for existing stock before receiving another delivery.')
    const nextCost = data.kind === 'RECEIPT' ? await weightedCost(client, product, data.quantity, data.purchaseRate) : product.purchase_cost
    await recordMovement(client, product, delta, { kind: data.kind, actorId: req.user.id, reason: data.reason, requestKey: data.requestKey, nextCost, purchaseRate: data.kind === 'RECEIPT' ? data.purchaseRate : null, purchaseDate:data.kind==='RECEIPT'?data.purchaseDate:null })
    return { body: { duplicate: false } }
  })
})

// Keep every product, stock movement and sale reference. Removal is recoverable.
for (const action of ['remove','restore']) router.post(`/:id/${action}`, requireAdmin, validId, async (req, res, next) => {
  const parsed = lifecycleAction.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Enter a reason of at least 3 characters and refresh the item before trying again.' })
  await transaction(res, next, async client => {
    const current = await client.query('SELECT * FROM inventory_products WHERE id=$1 FOR UPDATE', [req.params.id])
    if (!current.rowCount) throw stockError('Product not found.', 404)
    const product = current.rows[0]
    if (product.version !== parsed.data.version) throw stockError('Stock or product details changed. Refresh and try again.')
    let outcome
    if (action === 'restore') {
      if (!product.removed_at) throw stockError('This item is not removed.')
      // Restore to archived for review, not directly to the sale picker.
      await client.query('UPDATE inventory_products SET removed_at=NULL,removed_by=NULL,removal_reason=NULL,is_active=false,version=version+1,updated_at=now() WHERE id=$1', [product.id])
      outcome = 'RESTORED'
    } else {
      if (product.removed_at) throw stockError('This item has already been removed.')
      const history = await client.query(`SELECT EXISTS (SELECT 1 FROM sale_items WHERE product_id=$1)
        OR EXISTS (SELECT 1 FROM inventory_movements WHERE product_id=$1 AND sale_id IS NOT NULL) AS used`, [product.id])
      outcome = history.rows[0].used ? 'ARCHIVED' : 'REMOVED'
      if (outcome === 'ARCHIVED') await client.query('UPDATE inventory_products SET is_active=false,version=version+1,updated_at=now() WHERE id=$1', [product.id])
      else await client.query('UPDATE inventory_products SET removed_at=now(),removed_by=$2,removal_reason=$3,is_active=false,version=version+1,updated_at=now() WHERE id=$1', [product.id,req.user.id,parsed.data.reason])
    }
    await client.query("INSERT INTO audit_logs (actor_id,action,affected_table,affected_record_id,change_metadata) VALUES ($1,$2,'inventory_products',$3,$4::jsonb)", [req.user.id,`PRODUCT_${outcome}`,product.id,JSON.stringify({ reason: parsed.data.reason, before: { stock: product.stock, purchaseRate: product.purchase_cost, isActive: product.is_active, removedAt: product.removed_at }, outcome })])
    return { body: { outcome } }
  })
})

router.get('/:id/movements', requireAdmin, validId, async (req, res, next) => {
  const parsed = z.coerce.number().int().min(1).max(100000).safeParse(req.query.page || 1)
  if (!parsed.success) return res.status(400).json({ error: 'Choose a valid page.' })
  try {
    const rows = await pool.query(`SELECT m.id::text,m.kind,m.quantity_delta AS delta,m.stock_after AS balance,m.purchase_rate::text AS "purchaseRate",m.cost_after::text AS "averageCost",to_char(m.purchase_date,'YYYY-MM-DD') AS "purchaseDate",m.reason,m.sale_id AS "saleId",m.created_at AS "createdAt",p.display_name AS actor
      FROM inventory_movements m JOIN profiles p ON p.id=m.actor_id WHERE m.product_id=$1 ORDER BY m.id DESC LIMIT 25 OFFSET $2`, [req.params.id,(parsed.data-1)*25])
    res.json({ movements: rows.rows, page: parsed.data, hasMore: rows.rowCount === 25 })
  } catch (error) { next(error) }
})

export default router
