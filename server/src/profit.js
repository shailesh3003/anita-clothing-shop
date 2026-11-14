// Calculate in PostgreSQL NUMERIC; unknown historical costs never become zero-cost profit.
export async function profitForRange(client, from, to) {
  const result = await client.query(`WITH costed_sales AS (
    SELECT s.id,s.total_amount,
      count(si.id)>0 AND bool_and(si.unit_cost IS NOT NULL) AS complete,
      round(sum(si.unit_cost * si.quantity),2) AS cost
    FROM sales s LEFT JOIN sale_items si ON si.sale_id=s.id
    WHERE s.voided_at IS NULL AND s.sale_date BETWEEN $1::date AND $2::date
    GROUP BY s.id
  ), return_events AS (
    SELECT r.id,-r.credit_amount AS total_amount,r.cost_reversal IS NOT NULL AS complete,-r.cost_reversal AS cost
    FROM sale_returns r WHERE r.return_date BETWEEN $1::date AND $2::date
  ), events AS (SELECT * FROM costed_sales UNION ALL SELECT * FROM return_events)
  SELECT round(coalesce(sum(total_amount) FILTER (WHERE complete),0),2)::text AS "costedSalesAmount",
    round(coalesce(sum(cost) FILTER (WHERE complete),0),2)::text AS "purchaseCost",
    round(coalesce(sum(total_amount-cost) FILTER (WHERE complete),0),2)::text AS "grossProfit",
    count(*) FILTER (WHERE NOT complete)::int AS "missingCostTransactions"
    FROM events`, [from,to])
  return result.rows[0]
}

export const saleProfitSelect = `
  CASE WHEN EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id=s.id)
    AND NOT EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id=s.id AND si.unit_cost IS NULL)
  THEN round(s.total_amount-(SELECT round(sum(si.unit_cost*si.quantity),2) FROM sale_items si WHERE si.sale_id=s.id),2)::text
  ELSE NULL END AS gross_profit`

export const saleNetProfitSelect = `
  CASE WHEN EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id=s.id)
    AND NOT EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id=s.id AND si.unit_cost IS NULL)
  THEN round(s.total_amount-(SELECT round(sum(si.unit_cost*si.quantity),2) FROM sale_items si WHERE si.sale_id=s.id)
    -coalesce((SELECT sum(r.credit_amount) FROM sale_returns r WHERE r.sale_id=s.id),0)
    +coalesce((SELECT sum(r.cost_reversal) FROM sale_returns r WHERE r.sale_id=s.id),0),2)::text
  ELSE NULL END AS gross_profit`
