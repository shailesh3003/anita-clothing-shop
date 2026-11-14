export async function returnsForRange(client,from,to,staffId=null){
  const result=await client.query(`SELECT coalesce(sum(r.credit_amount),0)::text AS amount,count(*)::int AS count,
    coalesce(sum(r.credit_amount) FILTER(WHERE r.settlement_method='CASH'),0)::text AS cash,
    coalesce(sum(r.credit_amount) FILTER(WHERE r.settlement_method='UPI'),0)::text AS upi,
    coalesce(sum(r.credit_amount) FILTER(WHERE r.settlement_method='CARD'),0)::text AS card,
    coalesce(sum(r.credit_amount) FILTER(WHERE r.settlement_method='OTHER'),0)::text AS other
    FROM sale_returns r JOIN sales s ON s.id=r.sale_id WHERE r.return_date BETWEEN $1::date AND $2::date
    AND ($3::uuid IS NULL OR s.created_by=$3)`,[from,to,staffId])
  return result.rows[0]
}

// Keep monetary subtraction exact until serialization; no Number conversion.
export function subtractMoney(left,right){
  const cents=value=>{const negative=String(value).startsWith('-');const [whole,fraction='']=String(value).replace(/^-/,'').split('.');const result=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));return negative?-result:result}
  const difference=cents(left)-cents(right),absolute=difference<0n?-difference:difference
  return `${difference<0n?'-':''}${absolute/100n}.${String(absolute%100n).padStart(2,'0')}`
}

export async function returnEvents(client,from,to){
  return (await client.query(`SELECT r.id,r.sale_id AS "saleId",to_char(r.return_date,'YYYY-MM-DD') AS "returnDate",r.created_at AS "createdAt",
    r.credit_amount::text AS "creditAmount",r.cost_reversal::text AS "costReversal",
    CASE WHEN r.cost_reversal IS NULL THEN NULL ELSE (-r.credit_amount+r.cost_reversal)::text END AS "profitChange",
    r.settlement_method AS "settlementMethod",r.settlement_amount::text AS "settlementAmount",r.replacement_sale_id AS "replacementSaleId",r.reason,p.display_name AS "recordedBy",
    (SELECT json_agg(json_build_object('itemName',si.item_name,'quantity',ri.quantity,'condition',ri.condition) ORDER BY ri.id)
      FROM sale_return_items ri JOIN sale_items si ON si.id=ri.sale_item_id WHERE ri.return_id=r.id) AS items
    FROM sale_returns r JOIN profiles p ON p.id=r.created_by WHERE r.return_date BETWEEN $1::date AND $2::date ORDER BY r.return_date DESC,r.created_at DESC,r.id`,[from,to])).rows
}
