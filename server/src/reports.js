import { Router } from 'express'
import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'
import { z } from 'zod'
import { pool } from './db.js'
import { getPeriodRange, validDate, validMonth } from './report-period.js'
import { profitForRange, saleProfitSelect } from './profit.js'
import { returnsForRange, returnEvents, subtractMoney } from './return-summary.js'

const router = Router()
const querySchema = z.object({
  period: z.enum(['day', 'week', 'month', 'custom']),
  date: z.string().optional(),
  month: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
})
const methodNames = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', OTHER: 'Other' }
const itemSummary = sale => sale.items?.length ? sale.items.map(item => `${item.itemName} × ${item.quantity}`).join(', ') : 'Item details unavailable'
const periodLabels = { day: 'Daily Sales Report', week: 'Weekly Sales Report', month: 'Monthly Sales Report', custom: 'Custom Date Range Sales Report' }
const filenameLabels = { day: 'Anita_Daily_Sales', week: 'Anita_Weekly_Sales', month: 'Anita_Monthly_Sales', custom: 'Anita_Custom_Sales' }
const navy = '202B39'
const gold = 'C6A15B'

function filenameFor(report, extension) {
  let suffix
  if (report.period === 'month') suffix = report.from.slice(0, 7)
  else if (report.period === 'day') suffix = report.from
  else suffix = `${report.from}_to_${report.to}`
  return `${filenameLabels[report.period]}_${suffix}.${extension}`
}

function parseRange(req, res) {
  const parsed = querySchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: 'Choose daily, weekly, monthly or custom report.' })
    return null
  }
  const { period, date, month, from, to } = parsed.data
  const selection = { date, month, from, to }
  try {
    if (period === 'custom' || (period === 'day' && date) || (period === 'week' && date) || (period === 'month' && month)) {
      const range = getPeriodRange(period, selection, undefined)
      return { period, selection, range }
    }
    if (date !== undefined && !validDate(date)) throw new Error('Choose a valid date.')
    if (month !== undefined && !validMonth(month)) throw new Error('Choose a valid month and year.')
    return { period, selection }
  } catch (error) {
    res.status(400).json({ error: error.message })
    return null
  }
}

async function loadReport(period, selection, fixedRange) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    let today
    if (!fixedRange && (period === 'day' || period === 'week' || (period === 'month' && !selection.month))) {
      const businessDate = await client.query("SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS today")
      today = businessDate.rows[0].today
    }
    const { from, to } = fixedRange || getPeriodRange(period, selection, today)
    const [aggregates, staff] = await Promise.all([
      client.query(
        `WITH filtered AS MATERIALIZED (
           SELECT s.id, to_char(s.sale_date, 'YYYY-MM-DD') AS sale_date, s.total_amount::text AS total_amount,
                  s.payment_method, s.description, s.created_at, creator.display_name AS created_by_name, ${saleProfitSelect},
                  COALESCE((SELECT json_agg(json_build_object('itemName', si.item_name, 'quantity', si.quantity,
                    'unitPrice', si.unit_price::text, 'unitCost', si.unit_cost::text, 'subtotal', (si.unit_price * si.quantity)::numeric(12, 2)::text)
                    ORDER BY si.line_number) FROM sale_items si WHERE si.sale_id = s.id), '[]'::json) AS items
             FROM sales s JOIN profiles creator ON creator.id = s.created_by
            WHERE s.sale_date BETWEEN $1::date AND $2::date AND s.voided_at IS NULL
         )
         SELECT (SELECT COALESCE(sum(total_amount::numeric), 0)::text FROM filtered) AS total_amount,
                (SELECT count(*)::int FROM filtered) AS transaction_count,
                (SELECT COALESCE(sum(total_amount::numeric) FILTER (WHERE payment_method = 'CASH'), 0)::text FROM filtered) AS cash_total,
                (SELECT COALESCE(sum(total_amount::numeric) FILTER (WHERE payment_method = 'UPI'), 0)::text FROM filtered) AS upi_total,
                (SELECT COALESCE(sum(total_amount::numeric) FILTER (WHERE payment_method = 'CARD'), 0)::text FROM filtered) AS card_total,
                (SELECT COALESCE(sum(total_amount::numeric) FILTER (WHERE payment_method = 'OTHER'), 0)::text FROM filtered) AS other_total,
                (SELECT json_agg(f ORDER BY f.sale_date DESC, f.created_at DESC, f.id DESC) FROM filtered f) AS sales`,
        [from, to],
      ),
      client.query(
        `WITH events AS (
          SELECT created_by,total_amount AS amount,1 AS sale_count FROM sales WHERE sale_date BETWEEN $1::date AND $2::date AND voided_at IS NULL
          UNION ALL SELECT s.created_by,-r.credit_amount,0 FROM sale_returns r JOIN sales s ON s.id=r.sale_id WHERE r.return_date BETWEEN $1::date AND $2::date
        ) SELECT creator.display_name AS name,coalesce(sum(e.amount),0)::text AS total_amount,sum(e.sale_count)::int AS transaction_count
          FROM events e JOIN profiles creator ON creator.id=e.created_by GROUP BY creator.id,creator.display_name ORDER BY creator.display_name`,
        [from, to],
      ),
    ])
    const row = aggregates.rows[0]
    const profit = await profitForRange(client, from, to)
    const refunds = await returnsForRange(client,from,to)
    const returns = await returnEvents(client,from,to)
    const report = {
      period, from, to,
      title: periodLabels[period],
      summary: { totalAmount: subtractMoney(row.total_amount,refunds.amount), grossSalesAmount:row.total_amount, returnsAmount:refunds.amount, returnCount:refunds.count, transactionCount: row.transaction_count,
        payments: { CASH: subtractMoney(row.cash_total,refunds.cash), UPI: subtractMoney(row.upi_total,refunds.upi), CARD: subtractMoney(row.card_total,refunds.card), OTHER: subtractMoney(row.other_total,refunds.other) }, profit },
      staff: staff.rows.map(value => ({ name: value.name, totalAmount: value.total_amount, transactionCount: value.transaction_count })),
      sales: row.sales || [],
      returns,
    }
    await client.query('COMMIT')
    return report
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

function createCsv(report) {
  const csvValue = value => {
    let string = value == null ? '' : String(value)
    if (/^\s*[-=+@]/.test(string) && !/^-?\d+(?:\.\d+)?$/.test(string)) string = `'${string}`
    return `"${string.replaceAll('"', '""')}"`
  }
  const rows = [
    ['Anita Clothing Shop', report.title],
    ['Selected date range', `${report.from} to ${report.to}`],
    ['Total sales (INR)', report.summary.totalAmount],
    ['Valid transaction count', report.summary.transactionCount],
    ...Object.entries(report.summary.payments).map(([key, amount]) => [`${methodNames[key]} total (INR)`, amount]),
    ...(report.summary.profit ? [['Costed sales (INR)', report.summary.profit.costedSalesAmount], ['Purchase cost (INR)', report.summary.profit.purchaseCost], ['Gross profit before expenses (INR)', report.summary.profit.grossProfit], ['Transactions with missing purchase cost', report.summary.profit.missingCostTransactions]] : []),
    ['Gross sales before returns (INR)',report.summary.grossSalesAmount ?? report.summary.totalAmount],
    ['Return credits (INR)',report.summary.returnsAmount ?? '0'], ['Return transactions',report.summary.returnCount ?? 0],
    ['Basis','Total sales and payment totals are net of return credits on the return date.'],
    [],
    ['Sale date', 'Sale time (Asia/Kolkata)', 'Total purchase amount (INR)', 'Payment method', 'Items', 'Description', 'Staff member', 'Gross profit (INR)'],
    ...report.sales.map(sale => [sale.sale_date, new Date(sale.created_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }), sale.total_amount, methodNames[sale.payment_method], itemSummary(sale), sale.description || '', sale.created_by_name, sale.gross_profit ?? 'Cost unavailable']),
    [],['Returns and exchanges'],
    ['Return date','Original sale','Return credit (INR)','Settlement (positive: collect, negative: refund)','Settlement method','Returned items / condition','Reason','Recorded by','Replacement sale'],
    ...(report.returns || []).map(value=>[value.returnDate,value.saleId,value.creditAmount,value.settlementAmount,methodNames[value.settlementMethod],value.items.map(item=>`${item.itemName} x ${item.quantity} (${item.condition})`).join('; '),value.reason,value.recordedBy,value.replacementSaleId || '']),
  ]
  return `\uFEFF${rows.map(row => row.map(csvValue).join(',')).join('\r\n')}`
}

function createWorkbook(report) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Anita Clothing Shop'
  const summary = workbook.addWorksheet('Summary')
  summary.addRows([
    ['Anita Clothing Shop'], [report.title], ['Selected date range', `${report.from} to ${report.to}`], [],
    ['Summary'], ['Total sales (INR)', report.summary.totalAmount], ['Valid transaction count', report.summary.transactionCount],
    ...Object.entries(report.summary.payments).map(([key, amount]) => [`${methodNames[key]} total (INR)`, amount]),
    [], ['Staff member', 'Sales total (INR)', 'Transaction count'],
    ...report.staff.map(person => [person.name, person.totalAmount, person.transactionCount]),
  ])
  summary.mergeCells('A1:C1')
  summary.mergeCells('A2:C2')
  summary.getRow(1).font = { bold: true, size: 18, color: { argb: `FF${navy}` } }
  summary.getRow(2).font = { bold: true, size: 13, color: { argb: `FF${gold}` } }
  summary.getRow(5).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  summary.getRow(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${navy}` } }
  summary.getRow(13).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  summary.getRow(13).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${navy}` } }
  summary.getColumn(1).width = 30
  summary.getColumn(2).width = 24
  summary.getColumn(3).width = 20
  if (report.summary.profit) summary.addRows([[], ['Costed sales (INR)', report.summary.profit.costedSalesAmount], ['Purchase cost (INR)', report.summary.profit.purchaseCost], ['Gross profit before expenses (INR)', report.summary.profit.grossProfit], ['Transactions with missing purchase cost', report.summary.profit.missingCostTransactions]])
  summary.addRows([[],['Gross sales before returns (INR)',report.summary.grossSalesAmount ?? report.summary.totalAmount],['Return credits (INR)',report.summary.returnsAmount ?? '0'],['Return transactions',report.summary.returnCount ?? 0],['Basis','Total sales are net of return credits on the return date.']])
  summary.getColumn(1).alignment={wrapText:true}

  const details = workbook.addWorksheet('Sales Details')
  details.columns = [
    { header: 'Sale date', key: 'saleDate', width: 15 }, { header: 'Sale time (Asia/Kolkata)', key: 'time', width: 24 },
    { header: 'Total purchase amount (INR)', key: 'amount', width: 27 }, { header: 'Payment method', key: 'payment', width: 18 },
    { header: 'Items', key: 'items', width: 42 }, { header: 'Description', key: 'description', width: 42 }, { header: 'Staff member', key: 'staff', width: 26 },
    { header: 'Gross profit (INR)', key: 'profit', width: 24 },
  ]
  details.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  details.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${navy}` } }
  report.sales.forEach(sale => details.addRow({
    saleDate: sale.sale_date,
    time: new Date(sale.created_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }),
    amount: sale.total_amount,
    payment: methodNames[sale.payment_method],
    items: itemSummary(sale),
    description: sale.description || '',
    staff: sale.created_by_name,
    profit: sale.gross_profit ?? 'Cost unavailable',
  }))
  details.views = [{ state: 'frozen', ySplit: 1 }]

  const itemDetails = workbook.addWorksheet('Sale Items')
  itemDetails.columns = [
    { header: 'Sale date', key: 'saleDate', width: 15 }, { header: 'Sale time (Asia/Kolkata)', key: 'time', width: 24 },
    { header: 'Item name', key: 'itemName', width: 32 }, { header: 'Quantity', key: 'quantity', width: 13 },
    { header: 'Price per item (INR)', key: 'unitPrice', width: 23 }, { header: 'Item subtotal (INR)', key: 'subtotal', width: 23 },
    { header: 'Staff member', key: 'staff', width: 26 },
    { header: 'Purchase cost per item (INR)', key: 'unitCost', width: 30 },
  ]
  itemDetails.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  itemDetails.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${navy}` } }
  report.sales.forEach(sale => sale.items.forEach(item => itemDetails.addRow({
    saleDate: sale.sale_date,
    time: new Date(sale.created_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }),
    itemName: item.itemName,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    subtotal: item.subtotal,
    staff: sale.created_by_name,
    unitCost: item.unitCost ?? 'Cost unavailable',
  })))
  itemDetails.views = [{ state: 'frozen', ySplit: 1 }]
  const returns=workbook.addWorksheet('Returns')
  returns.columns=[{header:'Return date',key:'returnDate',width:16},{header:'Original sale',key:'saleId',width:38},{header:'Return credit (INR)',key:'creditAmount',width:24},{header:'Settlement (+collect / -refund)',key:'settlementAmount',width:30},{header:'Method',key:'settlementMethod',width:14},{header:'Items and condition',key:'items',width:50},{header:'Reason',key:'reason',width:40},{header:'Approved by',key:'recordedBy',width:25},{header:'Replacement sale',key:'replacementSaleId',width:38},{header:'Profit adjustment',key:'profitChange',width:24}]
  returns.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}}
  returns.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:`FF${navy}`}}
  for(const value of report.returns || [])returns.addRow({...value,items:value.items.map(item=>`${item.itemName} x ${item.quantity} (${item.condition})`).join('; '),profitChange:value.profitChange ?? 'Cost unavailable'})
  returns.views=[{state:'frozen',ySplit:1}]
  return workbook
}

function createPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 38, bufferPages: true, info: { Title: `${report.title} — Anita Clothing Shop`, Author: 'Anita Clothing Shop' } })
    const chunks = []
    doc.on('data', chunk => chunks.push(chunk))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))

    const left = 38
    const pageWidth = doc.page.width - left * 2
    doc.fillColor(`#${navy}`).font('Helvetica-Bold').fontSize(20).text('Anita Clothing Shop', left, 38)
    doc.fillColor(`#${gold}`).fontSize(13).text(report.title, left, 66)
    doc.fillColor('#555555').font('Helvetica').fontSize(9).text(`Selected date range: ${report.from} to ${report.to}`, left, 87)

    const metrics = [
      ['Net sales (INR)', report.summary.totalAmount],
      ['Valid transactions', String(report.summary.transactionCount)],
      ['Cash total (INR)', report.summary.payments.CASH],
      ['UPI total (INR)', report.summary.payments.UPI],
      ['Card total (INR)', report.summary.payments.CARD],
      ['Other payment total (INR)', report.summary.payments.OTHER],
    ]
    const gap = 9
    const cardWidth = (pageWidth - gap) / 2
    metrics.forEach(([label, value], index) => {
      const column = index % 2
      const row = Math.floor(index / 2)
      const x = left + column * (cardWidth + gap)
      const y = 116 + row * 42
      doc.roundedRect(x, y, cardWidth, 34, 4).fill('#F7F1E7')
      doc.fillColor('#666666').font('Helvetica').fontSize(8).text(label, x + 9, y + 6, { width: cardWidth - 18 })
      doc.fillColor(`#${navy}`).font('Helvetica-Bold').fontSize(11).text(value, x + 9, y + 18, { width: cardWidth - 18 })
    })

    let y = 260
    doc.fillColor('#555555').font('Helvetica').fontSize(8).text(`Gross sales: INR ${report.summary.grossSalesAmount ?? report.summary.totalAmount} | Return credits: INR ${report.summary.returnsAmount ?? '0'} | Returns: ${report.summary.returnCount ?? 0}`,left,y)
    y+=22
    if (report.summary.profit) {
      const profit = report.summary.profit
      doc.fillColor(`#${navy}`).font('Helvetica-Bold').fontSize(10).text(`Gross profit before expenses: INR ${profit.grossProfit}`, left, y)
      y += 17
      doc.font('Helvetica').fontSize(8).text(`Costed sales: INR ${profit.costedSalesAmount} | Purchase cost: INR ${profit.purchaseCost}`, left, y)
      y += 14
      doc.text(`Missing purchase cost: ${profit.missingCostTransactions} transactions (excluded from profit).`, left, y)
      y += 23
    }
    if (report.staff.length) {
      doc.fillColor(`#${navy}`).font('Helvetica-Bold').fontSize(10).text('Sales by staff member', left, y)
      y += 17
      doc.font('Helvetica').fontSize(8).fillColor('#333333')
      for (const person of report.staff) {
        doc.text(`${person.name} — ${person.transactionCount} transactions — INR ${person.totalAmount}`, left, y, { width: pageWidth })
        y += 12
      }
      y += 8
    }

    const columns = [76, 57, 54, 123, 102, pageWidth - 412]
    const headers = ['Sale date / time', 'Amount (INR)', 'Payment', 'Items', 'Description', 'Staff member']
    const drawTableHeader = () => {
      doc.rect(left, y, pageWidth, 25).fill(`#${navy}`)
      let x = left + 5
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(7.5)
      headers.forEach((header, index) => { doc.text(header, x, y + 8, { width: columns[index] - 8, height: 12, ellipsis: true }); x += columns[index] })
      y += 25
    }
    doc.fillColor(`#${navy}`).font('Helvetica-Bold').fontSize(11).text('Sales details', left, y)
    y += 17
    drawTableHeader()
    if (!report.sales.length) {
      doc.fillColor('#666666').font('Helvetica').fontSize(9).text('No valid sales were recorded for this period.', left + 5, y + 12)
    }
    for (const sale of report.sales) {
      if (y + 39 > doc.page.height - 38) {
        doc.addPage()
        y = 38
        doc.fillColor(`#${navy}`).font('Helvetica-Bold').fontSize(10).text(`${report.title} — continued`, left, y)
        y += 20
        drawTableHeader()
      }
      const values = [
        `${sale.sale_date}\n${new Date(sale.created_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}`,
        `INR ${sale.total_amount}`, methodNames[sale.payment_method], itemSummary(sale), sale.description || '—', sale.created_by_name,
      ]
      if (Math.floor((y - 302) / 39) % 2 === 0) doc.rect(left, y, pageWidth, 38).fill('#FBFAF7')
      let x = left + 5
      doc.fillColor('#303943').font('Helvetica').fontSize(7.5)
      values.forEach((value, index) => { doc.text(value, x, y + 7, { width: columns[index] - 8, height: 27, ellipsis: true }); x += columns[index] })
      y += 38
      doc.strokeColor('#E8E4DB').moveTo(left, y).lineTo(left + pageWidth, y).stroke()
    }
    if(report.returns?.length){
      doc.addPage()
      doc.fillColor(`#${navy}`).font('Helvetica-Bold').fontSize(16).text('Returns and exchanges')
      doc.font('Helvetica').fontSize(9).text(`${report.from} to ${report.to}. Credits reduce sales on the return date.`).moveDown()
      for(const value of report.returns){
        doc.fillColor(`#${navy}`).font('Helvetica-Bold').fontSize(10).text(`${value.returnDate} | Return ${value.id}`)
        doc.font('Helvetica').fontSize(9).text(`Original sale: ${value.saleId}`)
        doc.text(`Credit: INR ${value.creditAmount} | Settlement: INR ${value.settlementAmount} (${methodNames[value.settlementMethod]}; positive collect / negative refund)`)
        if(value.replacementSaleId)doc.text(`Replacement sale: ${value.replacementSaleId}`)
        doc.text(`Profit adjustment: ${value.profitChange == null ? 'Cost unavailable' : 'INR '+value.profitChange}`)
        for(const item of value.items)doc.text(`${item.itemName} x ${item.quantity} | ${item.condition}`)
        doc.text(`Reason: ${value.reason} | Approved by: ${value.recordedBy}`).moveDown()
      }
    }
    doc.end()
  })
}

router.get('/', async (req, res, next) => {
  const parsed = parseRange(req, res)
  if (!parsed) return
  try { res.json(await loadReport(parsed.period, parsed.selection, parsed.range)) } catch (error) { next(error) }
})

router.get('/export.xlsx', async (req, res, next) => {
  const parsed = parseRange(req, res)
  if (!parsed) return
  try {
    const report = await loadReport(parsed.period, parsed.selection, parsed.range)
    const workbook = createWorkbook(report)
    const buffer = await workbook.xlsx.writeBuffer()
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filenameFor(report, 'xlsx')}"`)
    res.send(Buffer.from(buffer))
  } catch (error) { next(error) }
})

router.get('/export.csv', async (req, res, next) => {
  const parsed = parseRange(req, res)
  if (!parsed) return
  try {
    const report = await loadReport(parsed.period, parsed.selection, parsed.range)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filenameFor(report, 'csv')}"`)
    res.send(createCsv(report))
  } catch (error) { next(error) }
})

router.get('/export.pdf', async (req, res, next) => {
  const parsed = parseRange(req, res)
  if (!parsed) return
  try {
    const report = await loadReport(parsed.period, parsed.selection, parsed.range)
    const buffer = await createPdf(report)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filenameFor(report, 'pdf')}"`)
    res.send(buffer)
  } catch (error) { next(error) }
})

export { createCsv, createPdf, createWorkbook, filenameFor, loadReport }
export default router
