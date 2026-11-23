import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { createApp } from '../src/index.js'
import { pool } from '../src/db.js'
import ExcelJS from 'exceljs'
import { subtractMoney } from '../src/return-summary.js'

const stamp = randomUUID()
const password = 'Inventory-Verification-123!'
const products = []
let accounts = []
let server, base, admin, staff
async function api(path, method = 'GET', body, cookie = admin) {
  const response = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}
async function product(stock = 10, extra = {}) {
  const body = { sku: randomUUID(), name: 'Inventory test kurti', size: 'M', color: 'Blue', barcode: '', purchaseRate: '650.10', purchaseDate:'2020-01-01', reorderLevel: 3, openingStock: stock, requestKey: randomUUID(), ...extra }
  const created = await api('/inventory', 'POST', body)
  assert.equal(created.status, 201, JSON.stringify(created.body))
  products.push(created.body.product.id)
  return { ...created.body.product, input: body }
}
const line = (product, quantity = 1) => ({ productId: product.id, itemName: 'Untrusted browser label', quantity: String(quantity), unitPrice: '650.10' })
const saleBody = items => ({ saleDate: '2026-11-14', items, paymentMethod: 'CASH', description: 'Inventory test', idempotencyKey: randomUUID() })
async function stock(id) { return (await pool.query('SELECT stock FROM inventory_products WHERE id=$1', [id])).rows[0].stock }
async function version(id) { return (await pool.query('SELECT version FROM inventory_products WHERE id=$1', [id])).rows[0].version }

before(async () => {
  const hash = await bcrypt.hash(password, 4)
  const created = await pool.query("INSERT INTO profiles(email,display_name,password_hash,role) VALUES ($1,'Inventory Admin',$3,'ADMIN'),($2,'Inventory Staff',$3,'STAFF') RETURNING id,email", [`inventory-admin-${stamp}@test.invalid`,`inventory-staff-${stamp}@test.invalid`,hash])
  accounts = created.rows
  server = createApp().listen(0)
  await new Promise(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  for (const account of accounts) {
    const response = await fetch(`${base}/api/auth/login`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({email:account.email,password}) })
    assert.equal(response.status,200)
    const cookie = response.headers.get('set-cookie').split(';')[0]
    if (account.email.includes('admin')) admin=cookie
    else staff=cookie
  }
})

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)) }
  const ids=accounts.map(a=>a.id)
  if(ids.length){
    await pool.query('DELETE FROM inventory_movements WHERE actor_id=ANY($1::uuid[])',[ids])
    await pool.query('DELETE FROM audit_logs WHERE actor_id=ANY($1::uuid[])',[ids])
    await pool.query('DELETE FROM sale_return_items WHERE return_id IN (SELECT id FROM sale_returns WHERE created_by=ANY($1::uuid[]))',[ids])
    await pool.query('DELETE FROM sale_returns WHERE created_by=ANY($1::uuid[])',[ids])
    await pool.query('DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE created_by=ANY($1::uuid[]))',[ids])
    await pool.query('DELETE FROM sales WHERE created_by=ANY($1::uuid[])',[ids])
    await pool.query('DELETE FROM inventory_products WHERE created_by=ANY($1::uuid[])',[ids])
    await pool.query("DELETE FROM user_sessions WHERE sess->>'userId'=ANY($1::text[])",[ids])
    await pool.query('DELETE FROM profiles WHERE id=ANY($1::uuid[])',[ids])
  }
  await pool.end()
})

test('inventory reads require login; staff cannot create, adjust, edit, or read the movement ledger', async () => {
  const p=await product()
  assert.equal((await api('/inventory','GET',null,null)).status,401)
  assert.equal((await api('/inventory','GET',null,staff)).status,200)
  assert.equal((await api('/inventory','POST',p.input,staff)).status,403)
  assert.equal((await api(`/inventory/${p.id}`,'PATCH',p,staff)).status,403)
  assert.equal((await api(`/inventory/${p.id}/adjustments`,'POST',{},staff)).status,403)
  assert.equal((await api(`/inventory/${p.id}/movements`,'GET',null,staff)).status,403)
})

test('stock summary is admin-only and aggregates exact current values including archived stock', async () => {
  assert.equal((await api('/inventory/summary','GET',null,staff)).status,403)
  assert.equal((await api('/inventory/summary','GET',null,'')).status,401)
  const before = (await api('/inventory/summary')).body
  await product(2,{purchaseRate:'0.15',reorderLevel:3})
  const archived = await product(3,{purchaseRate:'0.20'})
  await pool.query('UPDATE inventory_products SET is_active=false WHERE id=$1',[archived.id])
  await product(0)
  const unknown = await product(4)
  await pool.query('UPDATE inventory_products SET purchase_cost=NULL WHERE id=$1',[unknown.id])
  const removed = await product(0)
  await pool.query("UPDATE inventory_products SET removed_at=now(),removed_by=$2,is_active=false,removal_reason='Summary test removal' WHERE id=$1",[removed.id,accounts[0].id])
  const response = await api('/inventory/summary')
  assert.equal(response.status,200)
  const after = response.body
  assert.equal(after.productCount-before.productCount,4)
  assert.equal(BigInt(after.availableUnits)-BigInt(before.availableUnits),9n)
  assert.equal(after.lowStockCount-before.lowStockCount,2)
  assert.equal(after.outOfStockCount-before.outOfStockCount,1)
  assert.equal(subtractMoney(after.stockValue,before.stockValue),'0.90')
  assert.equal(BigInt(after.missingCostUnits)-BigInt(before.missingCostUnits),4n)
  assert.ok(Number.isFinite(Date.parse(after.asOf)))
})

test('admin purchase-rate search uses exact rounded cost and never reveals matches to staff', async () => {
  const p = await product(2, { name: 'Rate lookup kurti', purchaseRate: '173.455555' })
  for (const q of ['173.46', '173.460000']) {
    const result = await api(`/inventory?q=${q}`)
    assert.equal(result.status, 200)
    assert.ok(result.body.products.some(row => row.id === p.id))
    const staffResult = await api(`/inventory?q=${q}`, 'GET', null, staff)
    assert.equal(staffResult.status, 200)
    assert.ok(!staffResult.body.products.some(row => row.id === p.id))
  }
  assert.ok(!(await api('/inventory?q=173.45')).body.products.some(row => row.id === p.id))
  for (const q of ['173.46oops', "173.46' OR 1=1--", '-173.46']) {
    const result = await api(`/inventory?q=${encodeURIComponent(q)}`)
    assert.equal(result.status, 200)
    assert.ok(!result.body.products.some(row => row.id === p.id))
  }
  const named = await api('/inventory?q=Rate%20lookup', 'GET', null, staff)
  assert.ok(named.body.products.some(row => row.id === p.id))
  assert.ok(named.body.products.every(row => !('purchaseRate' in row)))
  await pool.query('UPDATE inventory_products SET is_active=false WHERE id=$1', [p.id])
  assert.ok(!(await api('/inventory?q=173.46')).body.products.some(row => row.id === p.id))
})

test('product setup is idempotent; SKU/barcode uniqueness, validation, search and low-stock filters work', async () => {
  const p=await product(2,{barcode:randomUUID()})
  const duplicate=await api('/inventory','POST',p.input)
  assert.equal(duplicate.status,200);assert.equal(duplicate.body.product.id,p.id)
  assert.equal(await stock(p.id),2)
  assert.equal((await api('/inventory','POST',{...p.input,requestKey:randomUUID()})).status,409)
  assert.equal((await api('/inventory','POST',{...p.input,sku:randomUUID(),requestKey:randomUUID()})).status,409)
  for(const changes of [{openingStock:-1},{openingStock:1.5},{purchaseRate:'bad'},{purchaseRate:'-1'},{reorderLevel:-1},{name:''}]) assert.equal((await api('/inventory','POST',{...p.input,sku:randomUUID(),barcode:'',requestKey:randomUUID(),...changes})).status,400)
  assert.equal((await api(`/inventory?q=${p.barcode}&status=low`)).body.products[0].id,p.id)
  assert.equal((await api(`/inventory?q=${p.sku}`)).body.products[0].id,p.id)
  const history=await api(`/inventory/${p.id}/movements`)
  assert.equal(history.body.movements.length,1);assert.equal(history.body.movements[0].kind,'OPENING')
})

test('a sale deducts aggregated repeated product lines once, uses a server name, and retry does not deduct again', async () => {
  const p=await product(10)
  const body=saleBody([line(p,2),{...line(p,3),productId:p.id.toUpperCase()}])
  const created=await api('/sales','POST',body,staff)
  assert.equal(created.status,201,JSON.stringify(created.body));assert.equal(await stock(p.id),5)
  assert.equal(created.body.sale.items[0].itemName,'Inventory test kurti / M / Blue')
  assert.equal(created.body.sale.totalAmount,'3250.50')
  const duplicate=await api('/sales','POST',body,staff)
  assert.equal(duplicate.status,200);assert.equal(await stock(p.id),5)
  const report=await api(`/inventory?q=${p.sku}`)
  assert.equal(report.body.products[0].soldQuantity,5)
  const history=await api(`/inventory/${p.id}/movements`)
  assert.equal(history.body.movements.filter(m=>m.kind==='SALE').length,1)
})

test('insufficient or missing stock rolls back the entire sale, its ledger, and every other product deduction', async () => {
  const [a,b]=[await product(5),await product(1)].sort((left,right)=>left.id.localeCompare(right.id))
  const body=saleBody([line(a,1),line(b,b.stock+1)])
  assert.equal((await api('/sales','POST',body,staff)).status,409)
  assert.equal(await stock(a.id),a.stock);assert.equal(await stock(b.id),b.stock)
  assert.equal((await pool.query('SELECT id FROM sales WHERE idempotency_key=$1',[body.idempotencyKey])).rowCount,0)
  assert.equal((await api('/sales','POST',saleBody([{itemName:'Unlinked',quantity:1,unitPrice:'1.00'}]),staff)).status,400)
  assert.equal((await api('/sales','POST',saleBody([{...line(a),productId:randomUUID()}]),staff)).status,400)
})

test('concurrent staff sales cannot oversell the last available unit', async () => {
  const p=await product(1)
  const results=await Promise.all([api('/sales','POST',saleBody([line(p)]),staff),api('/sales','POST',saleBody([line(p)]),staff)])
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal(await stock(p.id),0)
})

test('concurrent retry of the same sale saves and deducts only once', async () => {
  const p=await product(2), body=saleBody([line(p)])
  const results=await Promise.all([api('/sales','POST',body,staff),api('/sales','POST',body,staff)])
  assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(await stock(p.id),1)
  assert.equal(results[0].body.sale.id,results[1].body.sale.id)
})

test('admin corrections reconcile net quantities and product substitutions; void restores only once', async () => {
  const a=await product(10), b=await product(8)
  const sale=await api('/sales','POST',saleBody([line(a,3)]),staff)
  const path=`/sales/${sale.body.sale.id}`
  const correction={saleDate:'2026-11-14',items:[line(a,1),line(b,2)],paymentMethod:'UPI',description:'Corrected',reason:'Wrong size selected'}
  assert.equal((await api(path,'PATCH',correction,staff)).status,403)
  assert.equal((await api(path,'PATCH',correction)).status,200)
  assert.equal(await stock(a.id),9);assert.equal(await stock(b.id),6)
  assert.equal((await api(path,'PATCH',{...correction,items:[line(a,99)]})).status,409)
  assert.equal(await stock(a.id),9);assert.equal(await stock(b.id),6)
  assert.equal((await api(path,'PATCH',{...correction,items:[{itemName:'Unlinked',quantity:1,unitPrice:'1'}]})).status,400)
  assert.equal((await api(path+'/void','POST',{reason:'Cancelled incorrect sale'})).status,200)
  assert.equal(await stock(a.id),10);assert.equal(await stock(b.id),8)
  assert.equal((await api(path+'/void','POST',{reason:'Repeat cancellation'})).status,409)
  assert.equal(await stock(a.id),10)
  assert.equal((await api(`/inventory?q=${a.sku}`)).body.products[0].soldQuantity,0)
  const history=(await api(`/inventory/${a.id}/movements`)).body.movements
  assert.ok(history.some(m=>m.kind==='CORRECTION'&&m.delta===2));assert.ok(history.some(m=>m.kind==='VOID'&&m.delta===1))
})

test('receipts, damage and counts are audited and idempotent; stale counts cannot overwrite a new sale', async () => {
  const p=await product(5)
  const receipt={kind:'RECEIPT',purchaseDate:'2020-01-02',purchaseRate:'650.10',quantity:3,reason:'Delivery INV-112',expectedVersion:await version(p.id),requestKey:randomUUID()}
  assert.equal((await api(`/inventory/${p.id}/adjustments`,'POST',receipt)).status,200)
  assert.equal((await api(`/inventory/${p.id}/adjustments`,'POST',receipt)).body.duplicate,true)
  assert.equal(await stock(p.id),8)
  assert.equal((await api(`/inventory/${p.id}/adjustments`,'POST',{...receipt,kind:'DAMAGE',quantity:9,expectedVersion:await version(p.id),requestKey:randomUUID()})).status,409)
  assert.equal((await api(`/inventory/${p.id}/adjustments`,'POST',{...receipt,kind:'DAMAGE',quantity:2,expectedVersion:await version(p.id),requestKey:randomUUID()})).status,200)
  const oldVersion=await version(p.id)
  assert.equal((await api('/sales','POST',saleBody([line(p)]),staff)).status,201)
  const count={kind:'COUNT',quantity:4,reason:'Physical shelf count',expectedVersion:oldVersion,requestKey:randomUUID()}
  assert.equal((await api(`/inventory/${p.id}/adjustments`,'POST',count)).status,409)
  assert.equal(await stock(p.id),5)
  assert.equal((await api(`/inventory/${p.id}/adjustments`,'POST',{...count,expectedVersion:await version(p.id)})).status,200)
  assert.equal(await stock(p.id),4)
  const history=(await api(`/inventory/${p.id}/movements`)).body.movements
  assert.ok(history.some(m=>m.kind==='COUNT'&&m.delta===-1&&m.reason==='Physical shelf count'))
})

test('archiving prevents further sales but preserves old names and permits an audited void', async () => {
  const p=await product(3)
  const sale=await api('/sales','POST',saleBody([line(p)]),staff)
  assert.equal((await api(`/inventory/${p.id}`,'PATCH',{...p,name:'Renamed',isActive:false,version:await version(p.id)})).status,200)
  assert.equal((await api('/sales','POST',saleBody([line(p)]),staff)).status,409)
  assert.equal((await api(`/inventory?q=${p.sku}&status=archived`)).body.products[0].id,p.id)
  const voided=await api(`/sales/${sale.body.sale.id}/void`,'POST',{reason:'Correct mistaken entry'})
  assert.equal(voided.status,200);assert.equal(await stock(p.id),3)
  assert.equal(voided.body.sale.items[0].itemName,'Inventory test kurti / M / Blue')
})

test('concurrent adjustment retries apply once and stale product edits are rejected', async () => {
  const p=await product(4)
  const adjustment={kind:'RECEIPT',purchaseDate:'2020-01-02',purchaseRate:'650.10',quantity:2,reason:'Delivery retry verification',expectedVersion:p.version,requestKey:randomUUID()}
  const results=await Promise.all([api(`/inventory/${p.id}/adjustments`,'POST',adjustment),api(`/inventory/${p.id}/adjustments`,'POST',adjustment)])
  assert.ok(results.every(result=>result.status===200));assert.equal(results.filter(result=>result.body.duplicate).length,1)
  assert.equal(await stock(p.id),6)
  assert.equal((await api(`/inventory/${p.id}`,'PATCH',{...p,isActive:true})).status,409)
  const history=(await api(`/inventory/${p.id}/movements`)).body.movements
  assert.equal(history.filter(m=>m.kind==='RECEIPT').length,1)
})

test('legacy sales are untracked; voiding them does not invent a stock return', async () => {
  const p=await product(7)
  const adminAccount=accounts.find(account=>account.email.includes('admin'))
  const legacy=await pool.query("INSERT INTO sales(sale_date,total_amount,payment_method,created_by) VALUES ('2020-01-01',10,'CASH',$1) RETURNING id",[adminAccount.id])
  await pool.query("INSERT INTO sale_items(sale_id,line_number,item_name,quantity,unit_price) VALUES ($1,0,'Untracked historical item',1,10)",[legacy.rows[0].id])
  assert.equal((await api(`/sales/${legacy.rows[0].id}/void`,'POST',{reason:'Old incorrect entry'})).status,200)
  assert.equal(await stock(p.id),7)
})

test('every fixture product balance matches its complete movement ledger', async () => {
  for (const id of products) {
    const movements=(await pool.query('SELECT stock_before,stock_after,quantity_delta FROM inventory_movements WHERE product_id=$1 ORDER BY id',[id])).rows
    let balance=0
    for(const movement of movements){assert.equal(movement.stock_before,balance);balance+=movement.quantity_delta;assert.equal(movement.stock_after,balance);assert.ok(balance>=0)}
    assert.equal(await stock(id),balance)
  }
})

test('the full 100-line sale limit accepts product IDs; oversized and excessive-row requests fail safely', async () => {
  const p=await product(200)
  const items=Array.from({length:100},()=>line(p))
  assert.equal((await api('/sales','POST',saleBody(items),staff)).status,201)
  assert.equal(await stock(p.id),100)
  assert.equal((await api('/sales','POST',saleBody([...items,line(p)]),staff)).status,400)
  assert.equal((await api('/sales','POST',{...saleBody([line(p)]),description:'x'.repeat(140000)},staff)).status,413)
  assert.equal(await stock(p.id),100)
})

test('purchase rates and profit are admin-only and clients cannot forge the cost of a sale', async () => {
  const p=await product(4,{purchaseRate:'100.00'})
  const staffProduct=(await api(`/inventory?q=${p.sku}`,'GET',null,staff)).body.products[0]
  assert.equal('purchaseRate' in staffProduct,false);assert.equal('grossProfit' in staffProduct,false)
  const created=await api('/sales','POST',saleBody([{...line(p),unitPrice:'150.00',unitCost:'0'}]),staff)
  assert.equal(created.status,201);assert.equal('grossProfit' in created.body.sale,false)
  assert.equal('unitCost' in created.body.sale.items[0],false)
  const stored=await pool.query('SELECT unit_cost::text AS cost FROM sale_items WHERE sale_id=$1',[created.body.sale.id])
  assert.equal(stored.rows[0].cost,'100.000000')
  const dashboard=await api('/dashboard','GET',null,staff)
  assert.equal('profit' in dashboard.body.today,false)
})

test('delivery costs average existing stock, old profit is frozen, and corrections/voids preserve original cost', async () => {
  const p=await product(10,{purchaseRate:'100.00'})
  const created=await api('/sales','POST',saleBody([{...line(p,2),unitPrice:'150.00'}]))
  assert.equal(created.status,201);assert.equal(created.body.sale.grossProfit,'100.00')
  const delivery={kind:'RECEIPT',purchaseDate:'2020-01-02',quantity:2,purchaseRate:'200.00',reason:'Different supplier rate',expectedVersion:await version(p.id),requestKey:randomUUID()}
  assert.equal((await api(`/inventory/${p.id}/adjustments`,'POST',delivery)).status,200)
  assert.equal((await api(`/inventory?q=${p.sku}`)).body.products[0].purchaseRate,'120.000000')
  assert.equal((await api(`/inventory/${p.id}`,'PATCH',{...p,purchaseRate:'200.00',isActive:true,version:await version(p.id)})).status,200)
  const correction={saleDate:'2026-11-14',items:[{...line(p),unitPrice:'140.00'}],paymentMethod:'CASH',description:'Bargained correction',reason:'Incorrect recorded quantity'}
  const corrected=await api(`/sales/${created.body.sale.id}`,'PATCH',correction)
  assert.equal(corrected.status,200);assert.equal(corrected.body.sale.grossProfit,'40.00')
  assert.equal(corrected.body.sale.items[0].unitCost,'100.000000')
  assert.equal(await stock(p.id),11)
  assert.equal((await api(`/inventory?q=${p.sku}`)).body.products[0].purchaseRate,'190.909091')
  assert.equal((await api(`/sales/${created.body.sale.id}/void`,'POST',{reason:'Reverse mistaken sale'})).status,200)
  assert.equal(await stock(p.id),12)
  assert.equal((await api(`/inventory?q=${p.sku}`)).body.products[0].grossProfit,'0.00')
})

test('bargained prices can record a loss and exact small-paisa profits; reports and exports use the same profit', async () => {
  const p=await product(4,{purchaseRate:'50.00'})
  const body={...saleBody([{...line(p,2),unitPrice:'30.00'}]),saleDate:'2021-02-03'}
  const sold=await api('/sales','POST',body)
  assert.equal(sold.body.sale.grossProfit,'-40.00')
  const tiny=await product(3,{purchaseRate:'0.10'})
  const tinySale=await api('/sales','POST',{...saleBody([{...line(tiny,3),unitPrice:'0.20'}]),saleDate:'2021-02-03'})
  assert.equal(tinySale.body.sale.grossProfit,'0.30')
  const report=(await api('/reports?period=day&date=2021-02-03')).body
  assert.deepEqual(report.summary.profit,{costedSalesAmount:'60.60',purchaseCost:'100.30',grossProfit:'-39.70',missingCostTransactions:0})
  for(const format of ['csv','xlsx','pdf']){
    const response=await fetch(`${base}/api/reports/export.${format}?period=day&date=2021-02-03`,{headers:{cookie:admin}})
    assert.equal(response.status,200)
    if(format==='csv'){const text=await response.text();assert.ok(text.includes('Gross profit before expenses (INR)'));assert.ok(text.includes('"-39.70"'));assert.ok(!text.includes("'-39.70"))}
    if(format==='xlsx'){const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));let found=false;workbook.getWorksheet('Summary').eachRow(row=>{if(row.getCell(1).value==='Gross profit before expenses (INR)'){assert.equal(row.getCell(2).value,'-39.70');found=true}});assert.ok(found);assert.equal(workbook.getWorksheet('Sales Details').getCell('H2').value!=null,true)}
    if(format==='pdf')assert.ok(Buffer.from(await response.arrayBuffer()).subarray(0,5).toString().startsWith('%PDF-'))
  }
})

test('unknown historical cost is disclosed, never inferred from selling prices or later purchase rates', async () => {
  const p=await product(3)
  await pool.query('UPDATE inventory_products SET purchase_cost=NULL,selling_price=999 WHERE id=$1',[p.id])
  assert.equal((await api('/sales','POST',saleBody([line(p)]),staff)).status,409)
  assert.equal((await api(`/inventory/${p.id}/adjustments`,'POST',{kind:'RECEIPT',purchaseDate:'2020-01-02',quantity:1,purchaseRate:'100',expectedVersion:await version(p.id),reason:'Existing cost unknown',requestKey:randomUUID()})).status,409)
  const account=accounts.find(a=>a.email.includes('admin'))
  const legacy=await pool.query("INSERT INTO sales(sale_date,total_amount,payment_method,created_by) VALUES ('2021-02-04',500,'CASH',$1) RETURNING id",[account.id])
  await pool.query("INSERT INTO sale_items(sale_id,line_number,item_name,quantity,unit_price,product_id) VALUES ($1,0,'Historical product',1,500,$2)",[legacy.rows[0].id,p.id])
  assert.equal((await api(`/inventory/${p.id}`,'PATCH',{...p,purchaseRate:'100.00',isActive:true,version:await version(p.id)})).status,200)
  const report=(await api('/reports?period=day&date=2021-02-04')).body
  assert.equal(report.summary.profit.grossProfit,'0.00');assert.equal(report.summary.profit.missingCostTransactions,1)
  assert.equal(report.sales[0].gross_profit,null)
})

test('only admins can remove or restore inventory; validation and stale versions prevent accidental changes', async () => {
  const p=await product(7)
  const body={reason:'Duplicate product entered',version:p.version}
  assert.equal((await api(`/inventory/${p.id}/remove`,'POST',body,staff)).status,403)
  assert.equal((await api(`/inventory/${p.id}/restore`,'POST',body,staff)).status,403)
  assert.equal((await api(`/inventory/${p.id}/remove`,'POST',body,null)).status,401)
  assert.equal((await api('/inventory?status=removed','GET',null,staff)).status,403)
  assert.equal((await api(`/inventory/${p.id}/remove`,'POST',{...body,reason:' '})).status,400)
  assert.equal((await api(`/inventory/${p.id}/remove`,'POST',{...body,version:p.version-1})).status,409)
  assert.equal((await api('/inventory/not-an-id/remove','POST',body)).status,400)
  assert.equal((await api(`/inventory/${randomUUID()}/remove`,'POST',body)).status,404)
  assert.equal((await api(`/inventory/${p.id}/restore`,'POST',body)).status,409)
  assert.equal(await stock(p.id),7)
})

test('never-sold products are recoverably removed and blocked from sales/edits; restore preserves cost and quantity', async () => {
  const p=await product(7,{purchaseRate:'25.50'})
  const result=await api(`/inventory/${p.id}/remove`,'POST',{reason:'Wrong duplicate SKU',version:p.version})
  assert.equal(result.status,200);assert.equal(result.body.outcome,'REMOVED')
  for(const status of ['active','archived','all','low'])assert.equal((await api(`/inventory?q=${p.sku}&status=${status}`)).body.products.length,0)
  const removed=(await api(`/inventory?q=${p.sku}&status=removed`)).body.products[0]
  assert.equal(removed.isRemoved,true);assert.equal(removed.removalReason,'Wrong duplicate SKU')
  assert.equal(removed.purchaseRate,'25.500000');assert.equal(removed.stock,7)
  assert.equal((await api('/sales','POST',saleBody([line(p)]),staff)).status,409)
  assert.equal((await api(`/inventory/${p.id}`,'PATCH',{...p,isActive:true,version:removed.version})).status,409)
  assert.equal((await api(`/inventory/${p.id}/adjustments`,'POST',{kind:'COUNT',quantity:1,reason:'Invalid removed count',expectedVersion:removed.version,requestKey:randomUUID()})).status,409)
  assert.equal((await api(`/inventory/${p.id}/remove`,'POST',{reason:'Duplicate click',version:removed.version})).status,409)
  const restored=await api(`/inventory/${p.id}/restore`,'POST',{reason:'Removed by mistake',version:removed.version})
  assert.equal(restored.status,200);assert.equal(restored.body.outcome,'RESTORED')
  const archived=(await api(`/inventory?q=${p.sku}&status=archived`)).body.products[0]
  assert.equal(archived.isRemoved,false);assert.equal(archived.isActive,false);assert.equal(archived.stock,7)
  assert.equal(archived.purchaseRate,'25.500000')
  assert.equal((await api(`/inventory/${p.id}`,'PATCH',{...archived,isActive:true})).status,200)
  const audit=await pool.query("SELECT action,actor_id,change_metadata FROM audit_logs WHERE affected_record_id=$1 AND action IN ('PRODUCT_REMOVED','PRODUCT_RESTORED') ORDER BY id",[p.id])
  assert.deepEqual(audit.rows.map(row=>row.action),['PRODUCT_REMOVED','PRODUCT_RESTORED'])
  assert.ok(audit.rows.every(row=>accounts.some(account=>account.id===row.actor_id&&account.email.includes('admin'))))
  assert.equal(audit.rows[1].change_metadata.reason,'Removed by mistake')
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM inventory_movements WHERE product_id=$1',[p.id])).rows[0].count,1)
})

test('products with voided or corrected sales history are archived instead of removed', async () => {
  const a=await product(), b=await product()
  const sold=await api('/sales','POST',saleBody([line(a)]),staff)
  const id=sold.body.sale.id
  const correction={saleDate:'2026-11-14',items:[line(b)],paymentMethod:'CASH',description:'Wrong variant',reason:'Selected wrong item'}
  assert.equal((await api(`/sales/${id}`,'PATCH',correction)).status,200)
  assert.equal((await api(`/sales/${id}/void`,'POST',{reason:'Incorrect transaction'})).status,200)
  for(const p of [a,b]){
    const before=await stock(p.id)
    const result=await api(`/inventory/${p.id}/remove`,'POST',{reason:'Retire old item',version:await version(p.id)})
    assert.equal(result.status,200);assert.equal(result.body.outcome,'ARCHIVED')
    const archived=(await api(`/inventory?q=${p.sku}&status=archived`)).body.products[0]
    assert.equal(archived.isRemoved,false);assert.equal(archived.stock,before)
    assert.equal((await api(`/inventory?q=${p.sku}&status=removed`)).body.products.length,0)
  }
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM sales WHERE id=$1',[id])).rows[0].count,1)
})

test('a concurrent sale and removal cannot leave a sold product removed', async () => {
  const p=await product(1)
  const results=await Promise.all([api('/sales','POST',saleBody([line(p)]),staff),api(`/inventory/${p.id}/remove`,'POST',{reason:'Duplicate item setup',version:p.version})])
  const current=(await pool.query('SELECT removed_at,stock FROM inventory_products WHERE id=$1',[p.id])).rows[0]
  if(results[0].status===201){assert.equal(results[1].status,409);assert.equal(current.removed_at,null);assert.equal(current.stock,0)}
  else {assert.equal(results[0].status,409);assert.equal(results[1].status,200);assert.ok(current.removed_at);assert.equal(current.stock,1)}
})

async function returnSale(p,quantity=1,price='150.00',date='2020-01-02'){
  const result=await api('/sales','POST',{...saleBody([{...line(p,quantity),unitPrice:price}]),saleDate:date},staff)
  assert.equal(result.status,201,JSON.stringify(result.body));return result.body.sale
}
function returnBody(sale,quantity=1,condition='SELLABLE',date='2020-01-03'){
  return {returnDate:date,settlementMethod:'CASH',reason:'Customer return verified',requestKey:randomUUID(),items:[{saleItemId:sale.items[0].id,quantity,condition}]}
}

test('returns require admin approval and reject invalid quantities, conditions, dates, and foreign sale lines',async()=>{
  const p=await product(4),sale=await returnSale(p,2)
  const body=returnBody(sale)
  assert.equal((await api(`/returns/${sale.id}`,'POST',body,staff)).status,403)
  assert.equal((await api(`/returns/${sale.id}`,'GET',null,staff)).status,403)
  assert.equal((await api(`/returns/${sale.id}`,'POST',body,null)).status,401)
  for(const change of [{returnDate:'2019-12-31'},{returnDate:'2999-01-01'},{returnDate:'2020-02-30'},{reason:' '},{settlementMethod:'CHEQUE'},{items:[{...body.items[0],quantity:1.5}]},{items:[{...body.items[0],condition:'INVALID'}]},{items:[]}])assert.equal((await api(`/returns/${sale.id}`,'POST',{...body,...change})).status,400)
  assert.equal((await api(`/returns/${sale.id}`,'POST',{...body,items:[body.items[0],body.items[0]]})).status,400)
  assert.equal((await api(`/returns/${sale.id}`,'POST',{...body,items:[{...body.items[0],saleItemId:randomUUID()}]})).status,400)
  assert.equal((await api(`/returns/${sale.id}`,'POST',returnBody(sale,3))).status,409)
  assert.equal(await stock(p.id),2)
})

test('sellable return refunds the bargained price, freezes cost, restores stock once and locks subsequent edits/voids',async()=>{
  const p=await product(3,{purchaseRate:'80.00'}),sale=await returnSale(p,2,'120.25','2020-02-01')
  assert.equal((await api(`/inventory/${p.id}`,'PATCH',{...p,purchaseRate:'200.00',isActive:true,version:await version(p.id)})).status,200)
  const body={...returnBody(sale,1,'SELLABLE','2020-02-02'),creditAmount:'9999',items:[{...returnBody(sale).items[0],unitRefund:'9999'}]}
  const result=await api(`/returns/${sale.id}`,'POST',body)
  assert.equal(result.status,201,JSON.stringify(result.body));assert.equal(result.body.return.creditAmount,'120.25');assert.equal(result.body.return.settlementAmount,'-120.25')
  assert.equal(await stock(p.id),2)
  assert.equal((await api(`/inventory?q=${p.sku}`)).body.products[0].purchaseRate,'140.000000')
  const retry=await api(`/returns/${sale.id}`,'POST',body)
  assert.equal(retry.status,200);assert.equal(retry.body.duplicate,true);assert.equal(await stock(p.id),2)
  assert.equal((await api(`/returns/${sale.id}`,'POST',returnBody(sale,2,'SELLABLE','2020-02-02'))).status,409)
  assert.equal((await api(`/sales/${sale.id}/void`,'POST',{reason:'Cannot double reverse'})).status,409)
  assert.equal((await api(`/sales/${sale.id}`,'PATCH',{saleDate:'2020-02-01',paymentMethod:'CASH',reason:'Cannot replace returned rows'})).status,409)
  const history=(await api('/sales?from=2020-02-01&to=2020-02-01')).body.sales.find(value=>value.id===sale.id)
  assert.equal(history.items[0].returnedQuantity,1);assert.equal(history.grossProfit,'40.25')
  const report=(await api('/reports?period=day&date=2020-02-02')).body
  assert.equal(report.summary.totalAmount,'-120.25');assert.equal(report.summary.payments.CASH,'-120.25');assert.equal(report.summary.transactionCount,0);assert.equal(report.summary.returnCount,1)
  assert.deepEqual(report.summary.profit,{costedSalesAmount:'-120.25',purchaseCost:'-80.00',grossProfit:'-40.25',missingCostTransactions:0})
  const audit=await pool.query("SELECT actor_id FROM audit_logs WHERE action='RETURN_APPROVED' AND affected_record_id=$1",[result.body.return.id])
  assert.equal(audit.rowCount,1);assert.ok(accounts.some(account=>account.id===audit.rows[0].actor_id&&account.email.includes('admin')))
})

test('damaged and inspection returns stay out of sellable stock and damaged refunds retain the purchase-cost loss',async()=>{
  const p=await product(3,{purchaseRate:'80.00'}),sale=await returnSale(p,1,'150.00','2020-03-01')
  assert.equal((await api(`/returns/${sale.id}`,'POST',returnBody(sale,1,'DAMAGED','2020-03-02'))).status,201)
  assert.equal(await stock(p.id),2)
  const inventory=(await api(`/inventory?q=${p.sku}`)).body.products[0]
  assert.equal(inventory.damagedReturns,1);assert.equal(inventory.soldQuantity,0);assert.equal(inventory.grossProfit,'-80.00')
  const report=(await api('/reports?period=custom&from=2020-03-01&to=2020-03-02')).body
  assert.equal(report.summary.totalAmount,'0.00');assert.equal(report.summary.profit.grossProfit,'-80.00')
  const q=await product(2),inspection=await returnSale(q)
  assert.equal((await api(`/returns/${inspection.id}`,'POST',returnBody(inspection,1,'QUARANTINE'))).status,201);assert.equal(await stock(q.id),1)
  const movement=(await api(`/inventory/${p.id}/movements`)).body.movements.find(m=>m.kind==='RETURN_DAMAGED')
  assert.equal(movement.delta,0)
})

test('exchange atomically creates a replacement sale and records an additional payment or refund difference',async()=>{
  const a=await product(2,{purchaseRate:'60.00'}),b=await product(2,{purchaseRate:'80.00'}),sale=await returnSale(a,1,'100.00','2020-04-01')
  const result=await api(`/returns/${sale.id}`,'POST',{...returnBody(sale,1,'SELLABLE','2020-04-02'),settlementMethod:'UPI',replacementItems:[{...line(b),unitPrice:'150.00'}]})
  assert.equal(result.status,201,JSON.stringify(result.body));assert.equal(result.body.return.settlementAmount,'50.00');assert.ok(result.body.return.replacementSaleId)
  assert.equal(await stock(a.id),2);assert.equal(await stock(b.id),1)
  const report=(await api('/reports?period=day&date=2020-04-02')).body
  assert.equal(report.summary.totalAmount,'50.00');assert.equal(report.summary.payments.UPI,'50.00');assert.equal(report.summary.profit.grossProfit,'30.00');assert.equal(report.sales.length,1);assert.equal(report.returns.length,1)
  assert.equal(report.staff.find(value=>value.name==='Inventory Staff').totalAmount,'-100.00')
  assert.equal(report.staff.find(value=>value.name==='Inventory Admin').totalAmount,'150.00')
  assert.equal((await api(`/sales/${result.body.return.replacementSaleId}/void`,'POST',{reason:'Cannot undo payment separately'})).status,409)
  const cheaper=await returnSale(a,1,'100.00')
  const change=await api(`/returns/${cheaper.id}`,'POST',{...returnBody(cheaper),replacementItems:[{...line(b),unitPrice:'80.00'}]})
  assert.equal(change.status,201);assert.equal(change.body.return.settlementAmount,'-20.00')
  const c=await product(1),equalOriginal=await returnSale(a,1,'100.00')
  const equal=await api(`/returns/${equalOriginal.id}`,'POST',{...returnBody(equalOriginal),replacementItems:[{...line(c),unitPrice:'100.00'}]})
  assert.equal(equal.status,201);assert.equal(equal.body.return.settlementAmount,'0.00')
})

test('insufficient replacement stock rolls back the return, refund record, stock restoration and replacement sale',async()=>{
  const a=await product(2),b=await product(0),sale=await returnSale(a)
  const before=await version(a.id)
  const result=await api(`/returns/${sale.id}`,'POST',{...returnBody(sale),replacementItems:[line(b)]})
  assert.equal(result.status,409);assert.equal(await stock(a.id),1);assert.equal(await version(a.id),before);assert.equal(await stock(b.id),0)
  assert.equal((await api(`/returns/${sale.id}`)).body.returns.length,0)
  assert.equal((await pool.query('SELECT id FROM inventory_movements WHERE product_id=$1 AND kind LIKE $2',[a.id,'RETURN_%'])).rowCount,0)
})

test('concurrent return submissions and return/void races cannot double refund or double restock',async()=>{
  const p=await product(2),sale=await returnSale(p)
  const results=await Promise.all([api(`/returns/${sale.id}`,'POST',returnBody(sale)),api(`/returns/${sale.id}`,'POST',returnBody(sale))])
  assert.deepEqual(results.map(result=>result.status).sort(),[201,409]);assert.equal(await stock(p.id),2)
  const q=await product(2),original=await returnSale(q)
  const body=returnBody(original)
  const retry=await Promise.all([api(`/returns/${original.id}`,'POST',body),api(`/returns/${original.id}`,'POST',body)])
  assert.deepEqual(retry.map(result=>result.status).sort(),[200,201]);assert.equal(await stock(q.id),2)
  const r=await product(2),racing=await returnSale(r)
  const race=await Promise.all([api(`/returns/${racing.id}`,'POST',returnBody(racing)),api(`/sales/${racing.id}/void`,'POST',{reason:'Race reversal test'})])
  assert.equal(race.filter(result=>result.status===200||result.status===201).length,1);assert.equal(await stock(r.id),2)
})

test('partial return cost reversals do not accumulate rounding drift; exports include matching return details',async()=>{
  const p=await product(3,{purchaseRate:'0.333333'}),sale=await returnSale(p,3,'1.00','2020-05-01')
  for(let index=0;index<3;index++)assert.equal((await api(`/returns/${sale.id}`,'POST',returnBody(sale,1,'SELLABLE','2020-05-02'))).status,201)
  const report=(await api('/reports?period=custom&from=2020-05-01&to=2020-05-02')).body
  assert.equal(report.summary.totalAmount,'0.00');assert.equal(report.summary.profit.grossProfit,'0.00');assert.equal(report.returns.length,3)
  const totals=(await pool.query('SELECT sum(cost_reversal)::text AS amount FROM sale_returns WHERE sale_id=$1',[sale.id])).rows[0]
  assert.equal(totals.amount,'1.00')
  for(const format of ['pdf','xlsx','csv']){
    const response=await fetch(`${base}/api/reports/export.${format}?period=custom&from=2020-05-01&to=2020-05-02`,{headers:{cookie:admin}})
    assert.equal(response.status,200)
    if(format==='xlsx'){const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));assert.equal(workbook.getWorksheet('Returns').rowCount,4);assert.equal(workbook.getWorksheet('Summary').getCell('B6').value,'0.00')}
    if(format==='csv'){const text=await response.text();assert.ok(text.includes('Returns and exchanges'));assert.ok(text.includes('SELLABLE'));assert.ok(text.includes(sale.id))}
    if(format==='pdf'){const buffer=Buffer.from(await response.arrayBuffer());assert.equal(buffer.subarray(0,5).toString(),'%PDF-');assert.ok(buffer.includes(Buffer.from('%%EOF')))}
  }
})

test('unlinked historical returns stay under inspection and unknown costs are not guessed',async()=>{
  const account=accounts.find(value=>value.email.includes('admin'))
  const sale=(await pool.query("INSERT INTO sales(sale_date,total_amount,payment_method,created_by) VALUES ('2020-06-01',100,'CASH',$1) RETURNING id",[account.id])).rows[0]
  const item=(await pool.query("INSERT INTO sale_items(sale_id,line_number,item_name,quantity,unit_price) VALUES ($1,0,'Historical item',1,100) RETURNING id",[sale.id])).rows[0]
  const original={...sale,items:[item]}
  assert.equal((await api(`/returns/${sale.id}`,'POST',returnBody(original,1,'SELLABLE','2020-06-02'))).status,400)
  assert.equal((await api(`/returns/${sale.id}`,'POST',returnBody(original,1,'QUARANTINE','2020-06-02'))).status,201)
  const report=(await api('/reports?period=day&date=2020-06-02')).body
  assert.equal(report.summary.totalAmount,'-100.00');assert.equal(report.summary.profit.grossProfit,'0.00');assert.equal(report.summary.profit.missingCostTransactions,1)
})

test('today shared dashboard subtracts refunds by their actual method and hides staff profit',async()=>{
  const today=(await pool.query("SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS date")).rows[0].date
  const before=(await api('/dashboard','GET',null,staff)).body.today
  const p=await product(1,{purchaseRate:'100.00'}),sale=await returnSale(p,1,'150.00',today)
  const response=await api(`/returns/${sale.id}`,'POST',{...returnBody(sale,1,'SELLABLE',today),settlementMethod:'CARD'})
  assert.equal(response.status,201)
  const after=(await api('/dashboard','GET',null,staff)).body.today
  assert.equal(subtractMoney(after.totalAmount,before.totalAmount),'0.00')
  assert.equal(subtractMoney(after.payments.CASH,before.payments.CASH),'150.00')
  assert.equal(subtractMoney(after.payments.CARD,before.payments.CARD),'-150.00')
  assert.equal(after.transactionCount,before.transactionCount+1);assert.equal(after.returnCount,before.returnCount+1)
  assert.equal('profit' in after,false)
})

test('stock purchase dates are validated, retained for each receipt, and latest purchase is independent of entry order',async()=>{
  const p=await product(2,{purchaseDate:'2020-02-01'})
  assert.equal((await api(`/inventory?q=${p.sku}`)).body.products[0].lastPurchaseDate,'2020-02-01')
  for(const purchaseDate of [undefined,'2020-02-30','0000-01-01','2999-01-01']){
    assert.equal((await api('/inventory','POST',{...p.input,sku:randomUUID(),requestKey:randomUUID(),purchaseDate})).status,400)
    assert.equal((await api(`/inventory/${p.id}/adjustments`,'POST',{kind:'RECEIPT',purchaseRate:'650.10',purchaseDate,quantity:1,reason:'Invalid date test',expectedVersion:await version(p.id),requestKey:randomUUID()})).status,400)
  }
  assert.equal(await stock(p.id),2)
  const receipt={kind:'RECEIPT',purchaseRate:'650.10',purchaseDate:'2020-03-01',quantity:3,reason:'Dated purchase',expectedVersion:await version(p.id),requestKey:randomUUID()}
  assert.equal((await api(`/inventory/${p.id}/adjustments`,'POST',receipt)).status,200)
  assert.equal((await api(`/inventory/${p.id}/adjustments`,'POST',receipt)).body.duplicate,true)
  assert.equal((await api(`/inventory/${p.id}/adjustments`,'POST',{...receipt,purchaseDate:'2020-02-15',quantity:1,expectedVersion:await version(p.id),requestKey:randomUUID()})).status,200)
  assert.equal(await stock(p.id),6)
  const history=(await api(`/inventory/${p.id}/movements`)).body.movements
  assert.deepEqual(history.map(value=>value.purchaseDate),['2020-02-15','2020-03-01','2020-02-01'])
  assert.ok(history.every(value=>value.createdAt))
  assert.equal((await api(`/inventory?q=${p.sku}`)).body.products[0].lastPurchaseDate,'2020-03-01')
})

test('old or zero-opening stock has no guessed purchase date; counts and sales do not change purchase dates',async()=>{
  const empty=await product(0)
  assert.equal((await api(`/inventory?q=${empty.sku}`)).body.products[0].lastPurchaseDate,null)
  const p=await product(2)
  await pool.query('UPDATE inventory_movements SET purchase_date=NULL WHERE product_id=$1',[p.id])
  assert.equal((await api(`/inventory?q=${p.sku}`)).body.products[0].lastPurchaseDate,null)
  assert.equal((await api(`/inventory/${p.id}/movements`)).body.movements[0].purchaseDate,null)
  assert.equal((await api(`/inventory/${p.id}/adjustments`,'POST',{kind:'COUNT',quantity:3,reason:'Physical count only',expectedVersion:await version(p.id),requestKey:randomUUID()})).status,200)
  await returnSale(p)
  assert.equal((await api(`/inventory?q=${p.sku}`)).body.products[0].lastPurchaseDate,null)
})
