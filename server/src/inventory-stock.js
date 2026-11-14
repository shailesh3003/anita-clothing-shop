export function stockError(message, status = 409) {
  return Object.assign(new Error(message), { status, inventoryError: true })
}

export const productName = product => [product.name, product.size, product.color].filter(Boolean).join(' / ')

export async function recordMovement(client, product, delta, { actorId, kind, reason, saleId = null, requestKey = null, nextCost = product.purchase_cost, purchaseRate = null, returnId = null, purchaseDate = null }) {
  const after = product.stock + delta
  if (!Number.isSafeInteger(after) || after < 0) throw stockError('Not enough stock. Refresh availability and reduce the quantity.')
  if (after > 999999999) throw stockError('Stock exceeds the supported maximum quantity.')
  await client.query('UPDATE inventory_products SET stock = $2, purchase_cost=$3, version = version + 1, updated_at = now() WHERE id = $1', [product.id, after, nextCost])
  await client.query(
    `INSERT INTO inventory_movements (product_id, sale_id, kind, quantity_delta, stock_before, stock_after, reason, actor_id, request_key, purchase_rate,cost_before,cost_after,return_id,purchase_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [product.id, saleId, kind, delta, product.stock, after, reason, actorId, requestKey, purchaseRate,product.purchase_cost,nextCost,returnId,purchaseDate],
  )
}

// Call inside the sale transaction. Lock all affected variants in a consistent order.
// Use the net quantity change so corrections don't briefly release sellable stock.
export async function reconcileSaleStock(client, beforeItems, afterItems, details) {
  const oldQuantities = new Map()
  const newQuantities = new Map()
  for (const item of beforeItems) if (item.productId) oldQuantities.set(item.productId, (oldQuantities.get(item.productId) || 0) + Number(item.quantity))
  for (const item of afterItems) if (item.productId) newQuantities.set(item.productId, (newQuantities.get(item.productId) || 0) + Number(item.quantity))
  const ids = [...new Set([...oldQuantities.keys(), ...newQuantities.keys()])].sort()
  if (!ids.length) return
  const locked = await client.query('SELECT * FROM inventory_products WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids])
  if (locked.rowCount !== ids.length) throw stockError('A selected product no longer exists. Choose a valid product.', 400)
  for (const product of locked.rows) {
    const previous = oldQuantities.get(product.id) || 0
    const next = newQuantities.get(product.id) || 0
    if (next > 0 && product.removed_at) throw stockError('This item is removed and cannot be sold.')
    if (next > previous && !product.is_active) throw stockError('This product is archived and cannot be sold.')
    const previousLine = beforeItems.find(item => item.productId === product.id)
    const unitCost = previousLine ? previousLine.unitCost : product.purchase_cost
    if (next > 0 && !previousLine && unitCost == null) throw stockError('Ask an admin to enter the purchase rate before selling this product.')
    // Purchase cost is server-owned and is frozen for historical corrections.
    for (const item of afterItems) if (item.productId === product.id) { item.itemName = productName(product); item.unitCost = unitCost }
    const delta = previous - next
    let nextCost = product.purchase_cost
    if (delta > 0) nextCost = await weightedCost(client, product, delta, unitCost)
    if (delta) await recordMovement(client, product, delta, { ...details, nextCost })
  }
}

export async function weightedCost(client, product, received, rate) {
  if (rate == null || (product.stock > 0 && product.purchase_cost == null)) return null
  const result = await client.query('SELECT round(($1::numeric*$2::numeric+$3::numeric*$4::numeric)/($1::numeric+$3::numeric),6)::text AS cost', [product.stock,product.purchase_cost || '0',received,rate])
  return result.rows[0].cost
}
