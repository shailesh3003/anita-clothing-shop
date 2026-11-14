import { z } from 'zod'

const quantity = z.union([
  z.number().int().min(1).max(999999),
  z.string().regex(/^[1-9]\d{0,5}$/, 'Quantity must be a positive whole number.').transform(Number),
])

const unitPrice = z.string()
  .regex(/^\d{1,10}(?:\.\d{1,2})?$/, 'Enter a unit price with up to two decimal places.')

export const saleItemsSchema = z.array(z.object({
  itemName: z.string().trim().min(1, 'Enter an item name.').max(240, 'Item names must be 240 characters or fewer.'),
  productId: z.string().uuid().transform(value => value.toLowerCase()).nullable().optional(),
  quantity,
  unitPrice,
})).min(1, 'Add at least one item to this sale.').max(100, 'A sale can contain at most 100 item rows.')

const MAX_SALE_CENTS = 999999999999n

export function unitPriceToCents(value) {
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
}

export function calculateSaleTotal(items) {
  const totalCents = items.reduce((total, item) => total + unitPriceToCents(item.unitPrice) * BigInt(item.quantity), 0n)
  if (totalCents <= 0n) throw new Error('Sale total must be greater than ₹0.')
  if (totalCents > MAX_SALE_CENTS) throw new Error('Sale total exceeds the supported maximum amount.')
  return formatCents(totalCents)
}

export function formatCents(cents) {
  const whole = cents / 100n
  const fraction = String(cents % 100n).padStart(2, '0')
  return `${whole}.${fraction}`
}

export async function insertSaleItems(client, saleId, items) {
  for (const [lineNumber, item] of items.entries()) {
    await client.query(
      'INSERT INTO sale_items (sale_id, line_number, item_name, quantity, unit_price, product_id, unit_cost) VALUES ($1, $2, $3, $4, $5::numeric, $6, $7)',
      [saleId, lineNumber, item.itemName, item.quantity, item.unitPrice, item.productId || null, item.unitCost ?? null],
    )
  }
}

export async function getSaleItems(client, saleId) {
  const result = await client.query(
    `SELECT id, item_name AS "itemName", product_id AS "productId", quantity, unit_price::text AS "unitPrice", unit_cost::text AS "unitCost",
            (unit_price * quantity)::numeric(12, 2)::text AS subtotal
       FROM sale_items WHERE sale_id = $1 ORDER BY line_number`,
    [saleId],
  )
  return result.rows
}
