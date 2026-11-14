import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import ExcelJS from 'exceljs'
import { spawnSync } from 'node:child_process'
import { mkdtemp, unlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createApp } from '../src/index.js'
import { pool } from '../src/db.js'
import { createCsv } from '../src/reports.js'

const password = 'Phase3Test-password-872!'
const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const email = role => `phase3-${role}-${stamp}@test.invalid`
let adminId
let staffId
let adminCookie
let staffCookie
let baseUrl
let server
let saleIds = []
let adminEmail
let staffEmail
let workflowSaleIds = []
let workflowSaleDate
const products = {}

async function extractPdfText(pdf) {
  const folder = await mkdtemp(join(tmpdir(), 'anita-report-pdf-'))
  const file = join(folder, 'report.pdf')
  try {
    await writeFile(file, pdf)
    const result = spawnSync('pdftotext', [file, '-'], { encoding: 'utf8' })
    if (result.error?.code === 'ENOENT') return null
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  } finally {
    await unlink(file).catch(() => {})
    await rm(folder, { recursive: true, force: true })
  }
}

async function login(url, address) {
  const response = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: address, password }) })
  assert.equal(response.status, 200)
  return response.headers.get('set-cookie')?.split(';')[0]
}

before(async () => {
  const hash = await bcrypt.hash(password, 4)
  adminEmail = email('admin')
  staffEmail = email('staff')
  const accounts = await pool.query(
    `INSERT INTO profiles (email, display_name, password_hash, role)
     VALUES ($1, 'Phase 3 Test Admin', $3, 'ADMIN'), ($2, 'Phase 3 Test Staff', $3, 'STAFF')
     RETURNING id, email`,
    [adminEmail, staffEmail, hash],
  )
  adminId = accounts.rows.find(value => value.email === adminEmail).id
  staffId = accounts.rows.find(value => value.email === staffEmail).id
  const insertedSales = await pool.query(
    `INSERT INTO sales (sale_date, total_amount, payment_method, description, created_by, created_at)
     VALUES ('2026-10-05', 100.10, 'CASH', 'cash fixture', $1, '2026-10-05 10:00:00+05:30'),
            ('2026-10-08', 223.45, 'UPI', 'upi fixture', $1, '2026-10-08 12:30:00+05:30'),
            ('2026-10-09', 99.00, 'CARD', 'void fixture', $1, '2026-10-09 15:00:00+05:30'),
            ('2026-10-12', 500.00, 'OTHER', 'outside fixture', $1, '2026-10-12 15:00:00+05:30')
     RETURNING id`, [adminId],
  )
  saleIds = insertedSales.rows.map(value => value.id)
  await pool.query(
    `INSERT INTO sale_items (sale_id, line_number, item_name, quantity, unit_price)
     VALUES ($1, 0, 'Kurti', 2, 50.05)`, [saleIds[0]],
  )
  const staffSale = await pool.query(
    `INSERT INTO sales (sale_date, total_amount, payment_method, created_by)
     VALUES ((now() AT TIME ZONE 'Asia/Kolkata')::date, 77.77, 'CARD', $1) RETURNING id`,
    [staffId],
  )
  saleIds.push(staffSale.rows[0].id)
  await pool.query('UPDATE sales SET voided_at = now(), voided_by = $2 WHERE id = $1', [saleIds[2], adminId])
  server = createApp().listen(0)
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  baseUrl = `http://127.0.0.1:${server.address().port}`
  adminCookie = await login(baseUrl, adminEmail)
  staffCookie = await login(baseUrl, staffEmail)
  for (const name of ['Workflow scarf', 'Kurti', 'Saree', 'Leggings']) {
    const response = await fetch(`${baseUrl}/api/inventory`, { method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ name, sku: `${stamp}-${name}`, purchaseRate: '1.00', purchaseDate:'2020-01-01', reorderLevel: 5, openingStock: 1000, requestKey: randomUUID() }) })
    assert.equal(response.status, 201)
    products[name] = (await response.json()).product.id
  }
})

after(async () => {
  if (baseUrl && adminCookie) await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie: adminCookie } }).catch(() => {})
  if (baseUrl && staffCookie) await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie: staffCookie } }).catch(() => {})
  const allSaleIds = [...saleIds, ...workflowSaleIds]
  const productIds = Object.values(products)
  if (productIds.length) {
    await pool.query('DELETE FROM inventory_movements WHERE product_id = ANY($1::uuid[])', [productIds])
    await pool.query("DELETE FROM audit_logs WHERE affected_table='inventory_products' AND affected_record_id = ANY($1::text[])", [productIds])
  }
  if (allSaleIds.length) {
    await pool.query("DELETE FROM audit_logs WHERE affected_table = 'sales' AND affected_record_id = ANY($1::text[])", [allSaleIds])
    await pool.query('DELETE FROM sale_items WHERE sale_id = ANY($1::uuid[])', [allSaleIds])
    await pool.query('DELETE FROM sales WHERE id = ANY($1::uuid[])', [allSaleIds])
  }
  if (productIds.length) await pool.query('DELETE FROM inventory_products WHERE id = ANY($1::uuid[])', [productIds])
  if (adminId || staffId) await pool.query('DELETE FROM profiles WHERE id = ANY($1::uuid[])', [[adminId, staffId].filter(Boolean)])
  if (adminId || staffId) await pool.query("DELETE FROM user_sessions WHERE sess->>'userId' = ANY($1::text[])", [[adminId, staffId].filter(Boolean)])
  if (server) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  await pool.end()
})

test('reports require authentication and deny staff access', async () => {
  const anonymous = await fetch(`${baseUrl}/api/reports?period=day`)
  assert.equal(anonymous.status, 401)
  const staffReport = await fetch(`${baseUrl}/api/reports?period=custom&from=2026-10-05&to=2026-10-11`, { headers: { cookie: staffCookie } })
  assert.equal(staffReport.status, 403)
  for (const format of ['pdf', 'xlsx', 'csv']) {
    const staffExport = await fetch(`${baseUrl}/api/reports/export.${format}?period=custom&from=2026-10-05&to=2026-10-11`, { headers: { cookie: staffCookie } })
    assert.equal(staffExport.status, 403)
  }
})

test('admin and staff sessions expose only their authorized APIs', async () => {
  const adminMe = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: adminCookie } })
  const staffMe = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: staffCookie } })
  assert.equal((await adminMe.json()).user.role, 'ADMIN')
  assert.equal((await staffMe.json()).user.role, 'STAFF')
  assert.equal((await fetch(`${baseUrl}/api/admin/users`, { headers: { cookie: adminCookie } })).status, 200)
  assert.equal((await fetch(`${baseUrl}/api/admin/users`, { headers: { cookie: staffCookie } })).status, 403)
  assert.equal((await fetch(`${baseUrl}/api/sales`)).status, 401)
})

test('login issues protected eight-hour sessions and logout invalidates them', async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password }),
  })
  assert.equal(response.status, 200)
  const setCookie = response.headers.get('set-cookie')
  assert.match(setCookie, /HttpOnly/i)
  assert.match(setCookie, /SameSite=Lax/i)
  const cookie = setCookie.split(';')[0]
  const sessionId = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0]
  const expiration = await pool.query("SELECT round(extract(epoch FROM (expire - now())))::int AS seconds_left FROM user_sessions WHERE sid = $1", [sessionId])
  assert.ok(expiration.rows[0].seconds_left > 28600 && expiration.rows[0].seconds_left <= 28900)
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } })).status, 200)
  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie } })
  assert.equal(logout.status, 204)
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } })).status, 401)
})

test('production configuration sets HTTPS-only cookies and security headers', async () => {
  const previousEnvironment = process.env.NODE_ENV
  let productionServer
  process.env.NODE_ENV = 'production'
  try {
    productionServer = createApp().listen(0)
    await new Promise((resolve, reject) => { productionServer.once('listening', resolve); productionServer.once('error', reject) })
    const url = `http://127.0.0.1:${productionServer.address().port}`
    const health = await fetch(`${url}/api/health`)
    assert.equal(health.status, 200)
    assert.equal(health.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains')
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(health.headers.get('x-frame-options'), 'DENY')
    const loginResponse = await fetch(`${url}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ email: adminEmail, password }),
    })
    assert.equal(loginResponse.status, 200)
    assert.match(loginResponse.headers.get('set-cookie'), /Secure/i)
    assert.match(loginResponse.headers.get('set-cookie'), /HttpOnly/i)
  } finally {
    process.env.NODE_ENV = previousEnvironment
    if (productionServer) {
      productionServer.closeAllConnections()
      await new Promise(resolve => productionServer.close(resolve))
    }
  }
})

test('custom report aggregates exact amounts and excludes voided/out-of-range sales', async () => {
  const response = await fetch(`${baseUrl}/api/reports?period=custom&from=2026-10-05&to=2026-10-11`, { headers: { cookie: adminCookie } })
  assert.equal(response.status, 200)
  const report = await response.json()
  assert.equal(report.summary.totalAmount, '323.55')
  assert.equal(report.summary.transactionCount, 2)
  assert.deepEqual(report.summary.payments, { CASH: '100.10', UPI: '223.45', CARD: '0.00', OTHER: '0.00' })
  assert.equal(report.sales.length, 2)
  assert.equal(report.sales.find(sale => sale.description === 'cash fixture').items[0].subtotal, '100.10')
  assert.deepEqual(report.sales.find(sale => sale.description === 'upi fixture').items, [])
  assert.equal(report.staff.length, 1)
  assert.equal(report.staff[0].totalAmount, '323.55')
  assert.ok(report.sales.every(sale => sale.description !== 'void fixture' && sale.description !== 'outside fixture'))
})

test('monthly report date boundaries use the current Asia/Kolkata month', async () => {
  const response = await fetch(`${baseUrl}/api/reports?period=month&month=2026-10`, { headers: { cookie: adminCookie } })
  assert.equal(response.status, 200)
  const report = await response.json()
  assert.match(report.from, /^\d{4}-\d{2}-01$/)
  assert.equal(report.from.slice(0, 7), report.to.slice(0, 7))
})

test('weekly report is Monday through Sunday', async () => {
  const response = await fetch(`${baseUrl}/api/reports?period=week&date=2026-10-08`, { headers: { cookie: adminCookie } })
  assert.equal(response.status, 200)
  const report = await response.json()
  const monday = new Date(`${report.from}T12:00:00Z`).getUTCDay()
  const sunday = new Date(`${report.to}T12:00:00Z`).getUTCDay()
  assert.equal(monday, 1)
  assert.equal(sunday, 0)
  assert.equal(new Date(`${report.to}T12:00:00Z`) - new Date(`${report.from}T12:00:00Z`), 6 * 24 * 60 * 60 * 1000)
})

test('staff dashboard totals are scoped to that staff member', async () => {
  const response = await fetch(`${baseUrl}/api/dashboard`, { headers: { cookie: staffCookie } })
  assert.equal(response.status, 200)
  const dashboard = await response.json()
  assert.equal(dashboard.today.totalAmount, '77.77')
  assert.equal(dashboard.today.transactionCount, 1)
  assert.equal(dashboard.today.payments.CARD, '77.77')
  assert.equal(dashboard.recentSales.length, 1)
})

test('sale entry validates inputs, prevents duplicate submissions, and filters staff history', async () => {
  const todayResult = await pool.query("SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS today")
  const today = todayResult.rows[0].today
  workflowSaleDate = today
  const idempotencyKey = randomUUID()
  const baseSale = { saleDate: today, items: [{ itemName: 'Workflow scarf', productId: products['Workflow scarf'], quantity: '2', unitPrice: '62.70' }], paymentMethod: 'OTHER', description: 'Workflow test sale', idempotencyKey }
  for (const invalid of [
    { ...baseSale, items: [], idempotencyKey: randomUUID() },
    { ...baseSale, items: [{ itemName: '', quantity: '1', unitPrice: '1.00' }], idempotencyKey: randomUUID() },
    { ...baseSale, items: [{ itemName: 'Bad quantity', quantity: '0', unitPrice: '1.00' }], idempotencyKey: randomUUID() },
    { ...baseSale, items: [{ itemName: 'Fraction quantity', quantity: '1.5', unitPrice: '1.00' }], idempotencyKey: randomUUID() },
    { ...baseSale, items: [{ itemName: 'Negative price', quantity: '1', unitPrice: '-1.00' }], idempotencyKey: randomUUID() },
    { ...baseSale, items: [{ itemName: 'Zero sale', quantity: '1', unitPrice: '0.00' }], idempotencyKey: randomUUID() },
    { ...baseSale, items: [{ itemName: 'Excess value', quantity: '999999', unitPrice: '9999999999.99' }], idempotencyKey: randomUUID() },
    { ...baseSale, saleDate: '2026-02-30', idempotencyKey: randomUUID() },
    { ...baseSale, paymentMethod: 'CHEQUE', idempotencyKey: randomUUID() },
  ]) {
    const response = await fetch(`${baseUrl}/api/sales`, { method: 'POST', headers: { cookie: staffCookie, 'content-type': 'application/json' }, body: JSON.stringify(invalid) })
    assert.equal(response.status, 400)
  }
  const first = await fetch(`${baseUrl}/api/sales`, { method: 'POST', headers: { cookie: staffCookie, 'content-type': 'application/json' }, body: JSON.stringify(baseSale) })
  assert.equal(first.status, 201)
  const created = await first.json()
  workflowSaleIds.push(created.sale.id)
  assert.equal(created.sale.totalAmount, '125.40')
  assert.deepEqual(created.sale.items.map(item => [item.itemName, item.quantity, item.unitPrice, item.subtotal]), [['Workflow scarf', 2, '62.70', '125.40']])
  const duplicate = await fetch(`${baseUrl}/api/sales`, { method: 'POST', headers: { cookie: staffCookie, 'content-type': 'application/json' }, body: JSON.stringify(baseSale) })
  assert.equal(duplicate.status, 200)
  const repeated = await duplicate.json()
  assert.equal(repeated.duplicate, true)
  assert.equal(repeated.sale.id, created.sale.id)
  const stored = await pool.query('SELECT count(*)::int AS count FROM sales WHERE idempotency_key = $1', [idempotencyKey])
  assert.equal(stored.rows[0].count, 1)

  const staffHistory = await fetch(`${baseUrl}/api/sales?from=${today}&to=${today}`, { headers: { cookie: staffCookie } })
  const staffRows = (await staffHistory.json()).sales
  assert.ok(staffRows.some(sale => sale.id === created.sale.id))
  assert.ok(staffRows.every(sale => sale.createdBy === staffId))
  const adminHistory = await fetch(`${baseUrl}/api/sales?from=${today}&to=${today}`, { headers: { cookie: adminCookie } })
  assert.ok((await adminHistory.json()).sales.some(sale => sale.id === created.sale.id))
})

test('multi-item totals use exact cents; admin item edits replace rows and audit before/after details', async () => {
  const response = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { cookie: staffCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      saleDate: workflowSaleDate,
      items: [
        { itemName: 'Kurti', productId: products.Kurti, quantity: '2', unitPrice: '650.00' },
        { itemName: 'Saree', productId: products.Saree, quantity: '1', unitPrice: '1500.00' },
        { itemName: 'Leggings', productId: products.Leggings, quantity: '3', unitPrice: '250.00' },
      ],
      paymentMethod: 'UPI', description: 'Multi-item test sale', idempotencyKey: randomUUID(),
    }),
  })
  assert.equal(response.status, 201)
  const created = (await response.json()).sale
  workflowSaleIds.push(created.id)
  assert.equal(created.totalAmount, '3550.00')
  assert.deepEqual(created.items.map(item => item.subtotal), ['1300.00', '1500.00', '750.00'])

  const correctedItems = [
    { itemName: 'Kurti', productId: products.Kurti, quantity: '2', unitPrice: '650.00' },
    { itemName: 'Leggings', productId: products.Leggings, quantity: '3', unitPrice: '250.00' },
  ]
  const updatedResponse = await fetch(`${baseUrl}/api/sales/${created.id}`, {
    method: 'PATCH', headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ saleDate: workflowSaleDate, items: correctedItems, paymentMethod: 'UPI', description: 'Removed saree row', reason: 'Testing item row removal' }),
  })
  assert.equal(updatedResponse.status, 200)
  const updated = (await updatedResponse.json()).sale
  assert.equal(updated.totalAmount, '2050.00')
  assert.deepEqual(updated.items.map(item => item.itemName), ['Kurti', 'Leggings'])
  const audit = await pool.query("SELECT change_metadata FROM audit_logs WHERE affected_table = 'sales' AND affected_record_id = $1 AND action = 'SALE_UPDATED'", [created.id])
  assert.equal(audit.rows[0].change_metadata.before.items.length, 3)
  assert.equal(audit.rows[0].change_metadata.after.items.length, 2)
})

test('legacy sale edits preserve the aggregate total and may add real item details', async () => {
  const legacyId = saleIds[1]
  const history = await fetch(`${baseUrl}/api/sales?from=2026-10-08&to=2026-10-08`, { headers: { cookie: adminCookie } })
  const legacy = (await history.json()).sales.find(sale => sale.id === legacyId)
  assert.deepEqual(legacy.items, [])
  const metadataOnly = await fetch(`${baseUrl}/api/sales/${legacyId}`, {
    method: 'PATCH', headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ saleDate: '2026-10-08', paymentMethod: 'UPI', description: 'Legacy sale retained', reason: 'Legacy compatibility test' }),
  })
  assert.equal(metadataOnly.status, 200)
  const preserved = (await metadataOnly.json()).sale
  assert.equal(preserved.totalAmount, '223.45')
  assert.deepEqual(preserved.items, [])
  const attachDetails = await fetch(`${baseUrl}/api/sales/${legacyId}`, {
    method: 'PATCH', headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ saleDate: '2026-10-08', items: [{ itemName: 'Legacy identified item', quantity: '1', unitPrice: '223.45' }], paymentMethod: 'UPI', description: 'Legacy sale retained', reason: 'Added verified item details' }),
  })
  assert.equal(attachDetails.status, 200)
  const detailed = (await attachDetails.json()).sale
  assert.equal(detailed.totalAmount, '223.45')
  assert.equal(detailed.items[0].itemName, 'Legacy identified item')
})

test('staff are denied corrections; admin correction and void actions remain audited and voided totals are excluded', async () => {
  const saleId = workflowSaleIds[0]
  const correction = { saleDate: workflowSaleDate, items: [{ itemName: 'Corrected scarf', productId: products['Workflow scarf'], quantity: '1', unitPrice: '130.75' }], paymentMethod: 'CARD', description: 'Corrected workflow test sale', reason: 'Corrected test entry' }
  const staffCorrection = await fetch(`${baseUrl}/api/sales/${saleId}`, { method: 'PATCH', headers: { cookie: staffCookie, 'content-type': 'application/json' }, body: JSON.stringify(correction) })
  assert.equal(staffCorrection.status, 403)

  const adminCorrection = await fetch(`${baseUrl}/api/sales/${saleId}`, { method: 'PATCH', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify(correction) })
  assert.equal(adminCorrection.status, 200)
  const updated = (await adminCorrection.json()).sale
  assert.equal(updated.totalAmount, '130.75')
  assert.equal(updated.items[0].itemName, 'Workflow scarf')
  assert.equal(updated.paymentMethod, 'CARD')
  assert.equal(updated.updatedBy, adminId)

  const today = await pool.query("SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS today")
  const beforeVoidResponse = await fetch(`${baseUrl}/api/reports?period=custom&from=${today.rows[0].today}&to=${today.rows[0].today}`, { headers: { cookie: adminCookie } })
  const beforeVoid = await beforeVoidResponse.json()
  const voidRequest = await fetch(`${baseUrl}/api/sales/${saleId}/void`, { method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Void test entry' }) })
  assert.equal(voidRequest.status, 200)
  assert.ok((await voidRequest.json()).sale.voidedAt)
  const afterVoidResponse = await fetch(`${baseUrl}/api/reports?period=custom&from=${today.rows[0].today}&to=${today.rows[0].today}`, { headers: { cookie: adminCookie } })
  const afterVoid = await afterVoidResponse.json()
  const cents = value => BigInt(value.replace('.', ''))
  assert.equal(cents(beforeVoid.summary.totalAmount) - cents(afterVoid.summary.totalAmount), 13075n)
  assert.equal(beforeVoid.summary.transactionCount - afterVoid.summary.transactionCount, 1)

  const audit = await pool.query("SELECT action, actor_id FROM audit_logs WHERE affected_table = 'sales' AND affected_record_id = $1 ORDER BY id", [saleId])
  assert.deepEqual(audit.rows.map(row => row.action), ['SALE_CREATED', 'SALE_UPDATED', 'SALE_VOIDED'])
  assert.ok(audit.rows.slice(1).every(row => row.actor_id === adminId))
  const retained = await fetch(`${baseUrl}/api/sales?from=${today.rows[0].today}&to=${today.rows[0].today}`, { headers: { cookie: adminCookie } })
  assert.ok((await retained.json()).sales.find(sale => sale.id === saleId).voidedAt)
})

test('inactive accounts and expired database sessions lose access', async () => {
  const inactiveCookie = await login(baseUrl, staffEmail)
  await pool.query('UPDATE profiles SET is_active = false WHERE id = $1', [staffId])
  const inactiveResponse = await fetch(`${baseUrl}/api/sales`, { headers: { cookie: inactiveCookie } })
  assert.equal(inactiveResponse.status, 401)
  await pool.query('UPDATE profiles SET is_active = true WHERE id = $1', [staffId])
  assert.equal((await fetch(`${baseUrl}/api/sales`, { headers: { cookie: inactiveCookie } })).status, 401)

  const expiredCookie = await login(baseUrl, staffEmail)
  const rawCookie = decodeURIComponent(expiredCookie.split('=')[1])
  const sid = rawCookie.slice(2, rawCookie.lastIndexOf('.'))
  const expired = await pool.query("UPDATE user_sessions SET expire = now() - interval '1 minute' WHERE sid = $1", [sid])
  assert.equal(expired.rowCount, 1)
  assert.equal((await fetch(`${baseUrl}/api/sales`, { headers: { cookie: expiredCookie } })).status, 401)
})

test('invalid custom ranges are rejected by the server', async () => {
  const response = await fetch(`${baseUrl}/api/reports?period=custom&from=2026-10-12&to=2026-10-11`, { headers: { cookie: adminCookie } })
  assert.equal(response.status, 400)
})

test('all twelve period and export combinations match the report preview', async () => {
  const periods = [
    { query: 'period=day&date=2026-10-05', filename: 'Anita_Daily_Sales_2026-10-05' },
    { query: 'period=week&date=2026-10-08', filename: 'Anita_Weekly_Sales_2026-10-05_to_2026-10-11' },
    { query: 'period=month&month=2026-10', filename: 'Anita_Monthly_Sales_2026-10' },
    { query: 'period=custom&from=2026-10-05&to=2026-10-11', filename: 'Anita_Custom_Sales_2026-10-05_to_2026-10-11' },
  ]
  for (const period of periods) {
    const previewResponse = await fetch(`${baseUrl}/api/reports?${period.query}`, { headers: { cookie: adminCookie } })
    assert.equal(previewResponse.status, 200)
    const preview = await previewResponse.json()
    for (const format of ['pdf', 'xlsx', 'csv']) {
      const response = await fetch(`${baseUrl}/api/reports/export.${format}?${period.query}`, { headers: { cookie: adminCookie } })
      assert.equal(response.status, 200, `${period.query} ${format}`)
      assert.match(response.headers.get('content-disposition'), new RegExp(`${period.filename}\\.${format}`))
      if (format === 'pdf') {
        assert.match(response.headers.get('content-type'), /application\/pdf/)
        const pdf = Buffer.from(await response.arrayBuffer())
        assert.ok(pdf.subarray(0, 5).equals(Buffer.from('%PDF-')))
        assert.ok(pdf.includes(Buffer.from('%%EOF')))
        const pdfText = await extractPdfText(pdf)
        if (pdfText !== null) {
          assert.ok(pdfText.includes(preview.title))
          assert.ok(pdfText.includes(preview.from))
          assert.ok(pdfText.includes(preview.to))
          assert.ok(pdfText.includes(preview.summary.totalAmount))
          for (const sale of preview.sales) {
            assert.ok(pdfText.includes(sale.sale_date))
            assert.ok(pdfText.includes(sale.total_amount))
            assert.ok(pdfText.includes(sale.created_by_name))
            if (sale.description) assert.ok(pdfText.includes(sale.description))
          }
        }
        continue
      }
      if (format === 'xlsx') {
        assert.match(response.headers.get('content-type'), /spreadsheetml/)
        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()))
        const summary = workbook.getWorksheet('Summary')
        const details = workbook.getWorksheet('Sales Details')
      const itemDetails = workbook.getWorksheet('Sale Items')
        assert.equal(summary.getCell('B6').value, preview.summary.totalAmount)
        assert.equal(summary.getCell('B7').value, preview.summary.transactionCount)
        assert.equal(summary.getCell('B8').value, preview.summary.payments.CASH)
        assert.equal(summary.getCell('B9').value, preview.summary.payments.UPI)
        assert.equal(summary.getCell('B10').value, preview.summary.payments.CARD)
        assert.equal(summary.getCell('B11').value, preview.summary.payments.OTHER)
        assert.equal(details.rowCount, preview.sales.length + 1)
      assert.equal(itemDetails.rowCount, 1 + preview.sales.reduce((count, sale) => count + sale.items.length, 0))
        preview.sales.forEach((sale, index) => {
          const row = details.getRow(index + 2)
          assert.equal(row.getCell(1).value, sale.sale_date)
          assert.equal(row.getCell(3).value, sale.total_amount)
          assert.equal(row.getCell(4).value, { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', OTHER: 'Other' }[sale.payment_method])
          assert.equal(row.getCell(5).value, sale.items.length ? sale.items.map(item => `${item.itemName} × ${item.quantity}`).join(', ') : 'Item details unavailable')
          assert.equal(row.getCell(6).value, sale.description || '')
          assert.equal(row.getCell(7).value, sale.created_by_name)
        })
        continue
      }
      assert.match(response.headers.get('content-type'), /text\/csv/)
      const csv = await response.text()
      assert.ok(csv.includes(`"Total sales (INR)","${preview.summary.totalAmount}"`))
      assert.ok(csv.includes(`"Valid transaction count","${preview.summary.transactionCount}"`))
      assert.ok(csv.includes('"Sale date","Sale time (Asia/Kolkata)","Total purchase amount (INR)","Payment method","Items"'))
      assert.equal(csv.split('\r\n').filter(line => /^"\d{4}-\d{2}-\d{2}"/.test(line)).length, preview.sales.length)
      for (const sale of preview.sales) {
        assert.ok(csv.includes(`"${sale.total_amount}"`))
        assert.ok(csv.includes(`"${sale.created_by_name}"`))
        if (sale.description) assert.ok(csv.includes(sale.description))
      }
    }
  }
})

test('empty periods return valid, labeled reports in all three formats', async () => {
  const query = 'period=day&date=2001-01-01'
  const previewResponse = await fetch(`${baseUrl}/api/reports?${query}`, { headers: { cookie: adminCookie } })
  const preview = await previewResponse.json()
  assert.equal(preview.summary.totalAmount, '0.00')
  assert.equal(preview.summary.transactionCount, 0)
  assert.equal(preview.sales.length, 0)
  for (const format of ['pdf', 'xlsx', 'csv']) {
    const response = await fetch(`${baseUrl}/api/reports/export.${format}?${query}`, { headers: { cookie: adminCookie } })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-disposition'), /Anita_Daily_Sales_2001-01-01/)
    if (format === 'pdf') {
      const pdf = Buffer.from(await response.arrayBuffer())
      assert.ok(pdf.subarray(0, 5).equals(Buffer.from('%PDF-')))
      const pdfText = await extractPdfText(pdf)
      if (pdfText !== null) {
        assert.ok(pdfText.includes('No valid sales were recorded for this period.'))
      }
    }
    if (format === 'xlsx') {
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()))
      assert.equal(workbook.getWorksheet('Summary').getCell('B6').value, '0.00')
      assert.equal(workbook.getWorksheet('Sales Details').rowCount, 1)
      assert.equal(workbook.getWorksheet('Sale Items').rowCount, 1)
    }
    if (format === 'csv') {
      const csv = await response.text()
      assert.ok(csv.includes('"Valid transaction count","0"'))
      assert.ok(csv.includes('"Sale date","Sale time (Asia/Kolkata)"'))
    }
  }
})

test('CSV neutralizes formula-like sale descriptions', () => {
  const csv = createCsv({
    from: '2026-10-05', to: '2026-10-05',
    summary: { totalAmount: '1.00', transactionCount: 1, payments: { CASH: '1.00', UPI: '0', CARD: '0', OTHER: '0' } },
    sales: [{ sale_date: '2026-10-05', created_at: '2026-10-05T10:00:00Z', total_amount: '1.00', payment_method: 'CASH', description: '=HYPERLINK("bad")', created_by_name: 'Staff' }],
  })
  assert.ok(csv.includes(`"'=HYPERLINK(""bad"")"`))
})
