import { Router } from 'express'
import { z } from 'zod'
import { pool } from './db.js'
import { validDate } from './report-period.js'
import { calculateSaleTotal, getSaleItems, insertSaleItems, saleItemsSchema, formatCents, unitPriceToCents } from './sale-items.js'
import { recordMovement, reconcileSaleStock, stockError, weightedCost } from './inventory-stock.js'

const router = Router()
const schema = z.object({
  returnDate: z.string().refine(validDate),
  settlementMethod: z.enum(['CASH','UPI','CARD','OTHER']),
  reason: z.string().trim().min(3).max(300),
  requestKey: z.string().uuid().transform(value=>value.toLowerCase()),
  items: z.array(z.object({ saleItemId: z.string().uuid().transform(value=>value.toLowerCase()), quantity: z.number().int().min(1).max(999999), condition: z.enum(['SELLABLE','DAMAGED','QUARANTINE']) })).min(1).max(100),
  replacementItems: saleItemsSchema.optional(),
})

export async function returnHistory(client, saleId) {
  const result = await client.query(`SELECT r.id,to_char(r.return_date,'YYYY-MM-DD') AS "returnDate",r.created_at AS "createdAt",
    r.credit_amount::text AS "creditAmount",r.settlement_amount::text AS "settlementAmount",r.settlement_method AS "settlementMethod",
    r.replacement_sale_id AS "replacementSaleId",r.reason,p.display_name AS "recordedBy",
    (SELECT json_agg(json_build_object('saleItemId',ri.sale_item_id,'itemName',si.item_name,'quantity',ri.quantity,'condition',ri.condition,
      'unitRefund',ri.unit_refund::text) ORDER BY ri.id) FROM sale_return_items ri JOIN sale_items si ON si.id=ri.sale_item_id WHERE ri.return_id=r.id) AS items
    FROM sale_returns r JOIN profiles p ON p.id=r.created_by WHERE r.sale_id=$1 ORDER BY r.created_at DESC,r.id`,[saleId])
  return result.rows
}

router.get('/:id', async (req,res,next)=>{
  if(!z.string().uuid().safeParse(req.params.id).success)return res.status(400).json({error:'Sale ID is invalid.'})
  try { res.json({returns:await returnHistory(pool,req.params.id)}) } catch(error){next(error)}
})

router.post('/:id', async (req,res,next)=>{
  if(!z.string().uuid().safeParse(req.params.id).success)return res.status(400).json({error:'Sale ID is invalid.'})
  const parsed=schema.safeParse(req.body)
  if(!parsed.success)return res.status(400).json({error:'Choose returned items, whole quantities, condition, payment method, date and a reason.'})
  const data=parsed.data
  if(new Set(data.items.map(item=>item.saleItemId)).size!==data.items.length)return res.status(400).json({error:'Select each original sale line only once.'})
  let client
  try{
    client=await pool.connect();await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[data.requestKey])
    const duplicate=await client.query('SELECT id,sale_id,created_by FROM sale_returns WHERE request_key=$1',[data.requestKey])
    if(duplicate.rowCount){
      if(duplicate.rows[0].sale_id!==req.params.id.toLowerCase()||duplicate.rows[0].created_by!==req.user.id)throw stockError('This request key cannot be reused.')
      const history=await returnHistory(client,duplicate.rows[0].sale_id)
      await client.query('COMMIT');return res.json({return:history.find(value=>value.id===duplicate.rows[0].id),duplicate:true})
    }
    const sale=(await client.query("SELECT *,to_char(sale_date,'YYYY-MM-DD') AS date FROM sales WHERE id=$1 FOR UPDATE",[req.params.id])).rows[0]
    if(!sale)throw stockError('Sale not found.',404)
    if(sale.voided_at)throw stockError('Voided sales cannot be returned.')
    const today=(await client.query("SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS date")).rows[0].date
    if(data.returnDate<sale.date||data.returnDate>today)throw stockError('Return date must be between the sale date and today.',400)
    const original=await getSaleItems(client,sale.id)
    let credit=0n
    const lines=[]
    for(const selected of data.items){
      const item=original.find(item=>item.id===selected.saleItemId)
      if(!item)throw stockError('A returned item does not belong to this sale.',400)
      const returned=(await client.query('SELECT coalesce(sum(quantity),0)::int AS quantity FROM sale_return_items WHERE sale_item_id=$1',[item.id])).rows[0].quantity
      if(selected.quantity>item.quantity-returned)throw stockError('Return quantity exceeds the remaining purchased quantity.')
      if(selected.condition==='SELLABLE'&&!item.productId)throw stockError('This historical item has no inventory link. Keep it under inspection instead of restocking automatically.',400)
      credit+=unitPriceToCents(item.unitPrice)*BigInt(selected.quantity)
      lines.push({...selected,original:item})
    }
    const replacementItems=data.replacementItems || []
    const previousCredit=(await client.query('SELECT coalesce(sum(credit_amount),0)::text AS amount FROM sale_returns WHERE sale_id=$1',[sale.id])).rows[0].amount
    if(credit+unitPriceToCents(previousCredit)>unitPriceToCents(sale.total_amount))throw stockError('Total refunds cannot exceed the original sale amount.')
    if(replacementItems.some(item=>!item.productId))throw stockError('Choose an inventory product for every replacement item.',400)
    let replacementTotal='0.00'
    try { if(replacementItems.length)replacementTotal=calculateSaleTotal(replacementItems) }
    catch(error){throw stockError(error.message,400)}
    // Lock the union first: return and replacement may share variants and competing sales.
    const ids=[...new Set([...lines.map(line=>line.original.productId),...replacementItems.map(item=>item.productId)].filter(Boolean))].sort()
    const locked=ids.length?(await client.query('SELECT * FROM inventory_products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids])).rows:[]
    if(locked.length!==ids.length)throw stockError('A selected product no longer exists. Choose a valid product.',400)
    const created=(await client.query(`INSERT INTO sale_returns(sale_id,return_date,settlement_method,credit_amount,settlement_amount,reason,request_key,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[sale.id,data.returnDate,data.settlementMethod,formatCents(credit),signedCents(unitPriceToCents(replacementTotal)-credit),data.reason,data.requestKey,req.user.id])).rows[0]
    const costBefore=(await client.query("SELECT coalesce(sum(ri.unit_cost*ri.quantity),0)::text AS amount FROM sale_return_items ri JOIN sale_returns r ON r.id=ri.return_id WHERE r.sale_id=$1 AND ri.condition='SELLABLE'",[sale.id])).rows[0].amount
    for(const line of lines){
      const item=line.original
      await client.query('INSERT INTO sale_return_items(return_id,sale_item_id,quantity,condition,unit_refund,unit_cost) VALUES ($1,$2,$3,$4,$5,$6)',[created.id,item.id,line.quantity,line.condition,item.unitPrice,item.unitCost])
      if(item.productId){
        const product=(await client.query('SELECT * FROM inventory_products WHERE id=$1',[item.productId])).rows[0]
        const delta=line.condition==='SELLABLE'?line.quantity:0
        const nextCost=delta?await weightedCost(client,product,delta,item.unitCost):product.purchase_cost
        await recordMovement(client,product,delta,{actorId:req.user.id,kind:`RETURN_${line.condition}`,reason:data.reason,saleId:sale.id,returnId:created.id,nextCost})
      }
    }
    if(lines.every(line=>line.original.unitCost!=null))await client.query(`UPDATE sale_returns SET cost_reversal=(
      SELECT round(coalesce(sum(ri.unit_cost*ri.quantity),0),2)-round($2::numeric,2) FROM sale_return_items ri JOIN sale_returns r ON r.id=ri.return_id
      WHERE r.sale_id=$3 AND ri.condition='SELLABLE') WHERE id=$1`,[created.id,costBefore,sale.id])
    if(replacementItems.length){
      const replacement=(await client.query(`INSERT INTO sales(sale_date,total_amount,payment_method,description,created_by)
        VALUES ($1,$2,$3,$4,$5) RETURNING id`,[data.returnDate,replacementTotal,data.settlementMethod,`Exchange for sale ${sale.id}`,req.user.id])).rows[0]
      await reconcileSaleStock(client,[],replacementItems,{actorId:req.user.id,saleId:replacement.id,kind:'SALE',reason:'Exchange replacement',returnId:created.id})
      await insertSaleItems(client,replacement.id,replacementItems)
      await client.query('UPDATE sale_returns SET replacement_sale_id=$2 WHERE id=$1',[created.id,replacement.id])
      await client.query("INSERT INTO audit_logs(actor_id,action,affected_table,affected_record_id,change_metadata) VALUES ($1,'SALE_CREATED','sales',$2,$3::jsonb)",[req.user.id,replacement.id,JSON.stringify({returnId:created.id,originalSaleId:sale.id,items:replacementItems})])
    }
    await client.query("INSERT INTO audit_logs(actor_id,action,affected_table,affected_record_id,change_metadata) VALUES ($1,'RETURN_APPROVED','sale_returns',$2,$3::jsonb)",[req.user.id,created.id,JSON.stringify({saleId:sale.id,...data,creditAmount:formatCents(credit)})])
    const history=await returnHistory(client,sale.id)
    await client.query('COMMIT');res.status(201).json({return:history.find(value=>value.id===created.id),duplicate:false})
  }catch(error){
    if(client)await client.query('ROLLBACK').catch(()=>{})
    if(error.inventoryError)return res.status(error.status).json({error:error.message})
    next(error)
  }finally{client?.release()}
})

function signedCents(value){return value<0n?`-${formatCents(-value)}`:formatCents(value)}
export default router
