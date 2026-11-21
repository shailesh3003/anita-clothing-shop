import { Router } from 'express'
import { pool } from './db.js'
import { profitForRange } from './profit.js'

const router = Router()

router.get('/', async (req, res, next) => {
  // All authenticated shop staff share sales visibility; profit remains admin-only.
  const staffId = null
  try {
    const summary = await pool.query(
      `WITH local_today AS (
         SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS today
       ), sales_window AS (
         SELECT s.sale_date, s.total_amount, s.payment_method, s.created_by,true AS is_sale
         FROM sales s CROSS JOIN local_today d
         WHERE s.voided_at IS NULL AND ($1::uuid IS NULL OR s.created_by = $1)
         UNION ALL
         SELECT r.return_date,-r.credit_amount,r.settlement_method,s.created_by,false
         FROM sale_returns r JOIN sales s ON s.id=r.sale_id WHERE ($1::uuid IS NULL OR s.created_by=$1)
       )
       SELECT
         COALESCE(sum(w.total_amount) FILTER (WHERE w.sale_date = d.today), 0)::text AS today_total,
         count(*) FILTER (WHERE w.sale_date = d.today AND w.is_sale)::int AS today_count,
         count(*) FILTER (WHERE w.sale_date = d.today AND NOT w.is_sale)::int AS return_count,
         coalesce(sum(w.total_amount) FILTER(WHERE w.sale_date=d.today AND w.is_sale),0)::text AS gross_today,
         (-coalesce(sum(w.total_amount) FILTER(WHERE w.sale_date=d.today AND NOT w.is_sale),0))::text AS refunds_today,
         COALESCE(sum(w.total_amount) FILTER (WHERE w.sale_date = d.today AND w.payment_method = 'CASH'), 0)::text AS cash_total,
         COALESCE(sum(w.total_amount) FILTER (WHERE w.sale_date = d.today AND w.payment_method = 'UPI'), 0)::text AS upi_total,
         COALESCE(sum(w.total_amount) FILTER (WHERE w.sale_date = d.today AND w.payment_method = 'CARD'), 0)::text AS card_total,
         COALESCE(sum(w.total_amount) FILTER (WHERE w.sale_date = d.today AND w.payment_method = 'OTHER'), 0)::text AS other_total,
         COALESCE(sum(w.total_amount) FILTER (WHERE w.sale_date BETWEEN date_trunc('week', d.today)::date AND d.today), 0)::text AS week_total,
         COALESCE(sum(w.total_amount) FILTER (WHERE w.sale_date BETWEEN date_trunc('month', d.today)::date AND d.today), 0)::text AS month_total
       FROM local_today d LEFT JOIN sales_window w ON true`,
      [staffId],
    )
    const recent = await pool.query(
      `SELECT s.id, to_char(s.sale_date, 'YYYY-MM-DD') AS sale_date, s.total_amount::text AS total_amount,
              s.payment_method, s.description, s.created_at, creator.display_name AS created_by_name,
              COALESCE((SELECT json_agg(json_build_object('itemName', si.item_name, 'quantity', si.quantity)
                         ORDER BY si.line_number) FROM sale_items si WHERE si.sale_id = s.id), '[]'::json) AS items
         FROM sales s JOIN profiles creator ON creator.id = s.created_by
        WHERE s.voided_at IS NULL AND ($1::uuid IS NULL OR s.created_by = $1)
        ORDER BY s.sale_date DESC, s.created_at DESC, s.id DESC LIMIT 8`,
      [staffId],
    )
    const row = summary.rows[0]
    let profit
    if (req.user.role === 'ADMIN') {
      const date = await pool.query("SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS today")
      profit = await profitForRange(pool, date.rows[0].today, date.rows[0].today)
    }
    res.json({
      today: { totalAmount: row.today_total, grossSalesAmount:row.gross_today, returnsAmount:row.refunds_today, returnCount:row.return_count, transactionCount: row.today_count, payments: { CASH: row.cash_total, UPI: row.upi_total, CARD: row.card_total, OTHER: row.other_total }, ...(profit ? { profit } : {}) },
      weekTotal: row.week_total,
      monthTotal: row.month_total,
      recentSales: recent.rows.map(sale => ({ id: sale.id, saleDate: sale.sale_date, totalAmount: sale.total_amount, paymentMethod: sale.payment_method, description: sale.description, createdAt: sale.created_at, createdByName: sale.created_by_name, items: sale.items || [] })),
    })
  } catch (error) { next(error) }
})

export default router
