import { useLanguage } from './language.jsx'
import { useEffect, useState } from 'react'
import { Download, FileSpreadsheet, FileText } from 'lucide-react'
import './insights.css'

async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Could not load this information.')
  return data
}

function amount(value) {
  const negative=String(value ?? '0').startsWith('-')
  const [whole, fraction = ''] = String(value ?? '0').replace(/^-/,'').split('.')
  const grouped = whole.length > 3 ? `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}` : whole
  return `${negative?'-':''}₹${grouped}.${fraction.padEnd(2, '0')}`
}

function dateLabel(value, locale) {
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(`${value}T00:00:00+05:30`))
}

function timeLabel(value, locale) {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(value))
}

const methodLabels = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', OTHER: 'Other' }
function itemSummary(items = [], t) {
  if (!items.length) return t('Item details unavailable')
  const summary = items.slice(0, 2).map(item => `${item.itemName} × ${item.quantity}`)
  if (items.length > 2) summary.push(t('+{count} more', { count: items.length - 2 }))
  return summary.join(', ')
}

function todayInShopTimezone() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return parts
}

export function Dashboard({ user }) {
  const { t, locale } = useLanguage()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    request('/dashboard').then(value => { if (!cancelled) setData(value) }).catch(err => { if (!cancelled) setError(err.message) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  if (loading) return <p className="insight-status">{t("Loading your sales summary…")}</p>
  if (error) return <p className="insight-error" role="alert">{t(error)}</p>
  const payments = data.today.payments
  return <div className="insights-page">
    <div className="insight-heading"><div><p className="eyebrow">{user.role === 'ADMIN' ? t("SHOP OVERVIEW") : t("YOUR SALES")}</p><h2>{t("Today at the shop")}</h2><p>{t("Real recorded sales, with voided entries excluded.")}</p></div><span className="business-date">{dateLabel(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), locale)}</span></div>
    <section className="metric-grid" aria-label={t("Sales totals")}>
      <article className="metric-card metric-primary"><span>{t("Today's sales")}</span><strong>{amount(data.today.totalAmount)}</strong><small>{data.today.transactionCount} {data.today.transactionCount === 1 ? t("transaction") : t("transactions")}</small></article>
      <article className="metric-card"><span>{t("This week")}</span><strong>{amount(data.weekTotal)}</strong><small>{t("Monday to today")}</small></article>
      <article className="metric-card"><span>{t("This month")}</span><strong>{amount(data.monthTotal)}</strong><small>{t("Month to date")}</small></article>
    </section>
    <ReturnTotals summary={data.today}/>
    {user.role === 'ADMIN' && data.today.profit && <ProfitSummary profit={data.today.profit} />}
    <section className="insight-panel">
      <div className="insight-panel-heading"><div><p className="eyebrow">{t("TODAY'S BREAKDOWN")}</p><h3>{t("Payment methods")}</h3></div></div>
      <div className="payment-grid">{Object.entries(methodLabels).map(([key, label]) => <div className="payment-total" key={key}><span>{t(label)}</span><strong>{amount(payments[key])}</strong></div>)}</div>
    </section>
    <section className="insight-panel recent-panel">
      <div className="insight-panel-heading"><div><p className="eyebrow">{t("LATEST RECORDS")}</p><h3>{t("Recent sales")}</h3></div></div>
      {data.recentSales.length === 0 ? <p className="insight-status">{t("No recorded sales yet.")}</p> : <div className="insight-table-wrap"><table className="insight-table"><thead><tr><th>{t("Date & time")}</th><th>{t("Items")}</th><th>{t("Amount")}</th><th>{t("Payment")}</th>{user.role === 'ADMIN' && <th>{t("Staff")}</th>}</tr></thead><tbody>{data.recentSales.map(sale => <tr key={sale.id}><td>{dateLabel(sale.saleDate, locale)}<span className="insight-subtext">{timeLabel(sale.createdAt, locale)}</span></td><td>{itemSummary(sale.items, t)}</td><td className="insight-money">{amount(sale.totalAmount)}</td><td>{t(methodLabels[sale.paymentMethod])}</td>{user.role === 'ADMIN' && <td>{sale.createdByName}</td>}</tr>)}</tbody></table></div>}
    </section>
  </div>
}

export function Reports() {
  const { t, locale } = useLanguage()
  const [period, setPeriod] = useState('day')
  const [date, setDate] = useState(todayInShopTimezone)
  const [month, setMonth] = useState(() => todayInShopTimezone().slice(0, 7))
  const [from, setFrom] = useState(todayInShopTimezone)
  const [to, setTo] = useState(todayInShopTimezone)
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    const selection = { period }
    if (period === 'day' || period === 'week') selection.date = date
    if (period === 'month') selection.month = month
    if (period === 'custom') { selection.from = from; selection.to = to }
    if (period === 'custom' && (!from || !to)) {
      setReport(null); setLoading(false); setError(''); setMessage('')
      return () => controller.abort()
    }
    if (period === 'custom' && from > to) {
      setReport(null); setLoading(false); setError('Start date must be on or before end date.'); setMessage('')
      return () => controller.abort()
    }
    if ((period === 'day' || period === 'week') && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setReport(null); setLoading(false); setError('Choose a date to show this report.'); setMessage('')
      return () => controller.abort()
    }
    if (period === 'month' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      setReport(null); setLoading(false); setError('Choose a month and year to show this report.'); setMessage('')
      return () => controller.abort()
    }
    setLoading(true); setError(''); setMessage(''); setReport(null)
    const query = new URLSearchParams({ period })
    Object.entries(selection).forEach(([key, value]) => { if (key !== 'period') query.set(key, value) })
    request(`/reports?${query}`, { signal: controller.signal })
      .then(value => { setReport(value); setMessage('Report updated for the selected period.') })
      .catch(err => { if (err.name !== 'AbortError') setError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [period, date, month, from, to])

  function exportHref(format) {
    const query = new URLSearchParams({ period: report.period })
    if (report.period === 'day' || report.period === 'week') query.set('date', report.from)
    if (report.period === 'month') query.set('month', report.from.slice(0, 7))
    if (report.period === 'custom') { query.set('from', report.from); query.set('to', report.to) }
    return `/api/reports/export.${format}?${query}`
  }

  return <div className="insights-page">
    <div className="insight-heading"><div><p className="eyebrow">{t("ADMINISTRATION")}</p><h2>{t("Sales reports")}</h2><p>{t("Choose a period to refresh the report preview.")}</p></div></div>
    <div className="report-filters">
      <label>{t("Report period")}<select value={period} onChange={event => setPeriod(event.target.value)}><option value="day">{t("Daily")}</option><option value="week">{t("Weekly")}</option><option value="month">{t("Monthly")}</option><option value="custom">{t("Custom date range")}</option></select></label>
      {(period === 'day' || period === 'week') && <label>{period === 'day' ? t("Sale date") : t("Choose any date in the week")}<input type="date" value={date} onChange={event => setDate(event.target.value)} required /></label>}
      {period === 'month' && <label>{t("Month and year")}<input type="month" value={month} onChange={event => setMonth(event.target.value)} required /></label>}
      {period === 'custom' && <><label>{t("From")}<input type="date" value={from} max={to || undefined} onChange={event => setFrom(event.target.value)} required /></label><label>{t("To")}<input type="date" value={to} min={from || undefined} onChange={event => setTo(event.target.value)} required /></label></>}
    </div>
    {loading && <p className="insight-status" role="status">{t("Loading report…")}</p>}
    {error && <p className="insight-error" role="alert">{t(error)}</p>}
    {!loading && !error && !report && period === 'custom' && <p className="insight-status" role="status">{t("Choose both dates to show the custom report.")}</p>}
    {message && !loading && <p className="report-success" role="status">{t(message)}</p>}
    {report && <>
      <div className="report-period-caption">{t(report.title)}: {dateLabel(report.from, locale)} – {dateLabel(report.to, locale)}</div>
      {report.summary.profit && <ProfitSummary profit={report.summary.profit} />}
      <ReturnTotals summary={report.summary}/>
      <section className="metric-grid report-metrics"><article className="metric-card metric-primary"><span>{t('Net sales')}</span><strong>{amount(report.summary.totalAmount)}</strong><small>{t("Selected period")}</small></article><article className="metric-card"><span>{t("Transactions")}</span><strong>{report.summary.transactionCount}</strong><small>{t("Non-voided sales")}</small></article></section>
      <section className="insight-panel"><div className="insight-panel-heading"><div><p className="eyebrow">{t("PAYMENT BREAKDOWN")}</p><h3>{t("Totals by payment method")}</h3></div></div><div className="payment-grid">{Object.entries(methodLabels).map(([key, label]) => <div className="payment-total" key={key}><span>{t(label)}</span><strong>{amount(report.summary.payments[key])}</strong></div>)}</div></section>
      <section className="insight-panel"><div className="insight-panel-heading"><div><p className="eyebrow">{t("STAFF SUMMARY")}</p><h3>{t("Sales by staff member")}</h3></div></div>{report.staff.length === 0 ? <p className="insight-status">{t("No staff sales in this period.")}</p> : <div className="insight-table-wrap"><table className="insight-table"><thead><tr><th>{t("Staff member")}</th><th>{t("Transactions")}</th><th>{t('Net sales')}</th></tr></thead><tbody>{report.staff.map(person => <tr key={person.name}><td>{person.name}</td><td>{person.transactionCount}</td><td className="insight-money">{amount(person.totalAmount)}</td></tr>)}</tbody></table></div>}</section>
      <section className="insight-panel"><div className="insight-panel-heading report-record-heading"><div><p className="eyebrow">{t("TRANSACTIONS")}</p><h3>{t("Sales in this period")}</h3><p>{t('{count} matching sales', { count: report.sales.length })}</p></div><div className="export-actions"><a href={exportHref('pdf')} download className="export-button"><FileText size={16} /> {t("Download PDF")}</a><a href={exportHref('xlsx')} download className="export-button"><FileSpreadsheet size={16} /> {t("Download Excel")}</a><a href={exportHref('csv')} download className="export-button export-secondary"><Download size={15} /> {t("Download CSV")}</a></div></div>
        {report.sales.length === 0 ? <p className="insight-status">{t("No sales in this period. Downloads will include the period and zero-sales summary.")}</p> : <div className="insight-table-wrap"><table className="insight-table report-records"><thead><tr><th>{t("Date & time")}</th><th>{t("Items")}</th><th>{t("Amount")}</th><th>{t("Payment")}</th><th>{t("Description")}</th><th>{t("Staff member")}</th></tr></thead><tbody>{report.sales.map(sale => <tr key={sale.id}><td>{dateLabel(sale.sale_date, locale)}<span className="insight-subtext">{timeLabel(sale.created_at, locale)}</span></td><td><span className="item-summary">{itemSummary(sale.items, t)}</span>{sale.items?.length > 0 && <details className="item-details"><summary>{t(sale.items.length === 1 ? 'View item' : 'View items')}</summary><ul>{sale.items.map((item, itemIndex) => <li key={itemIndex}><span>{item.itemName} × {item.quantity}</span><small>{amount(item.unitPrice)} {t("each ·")} {amount(item.subtotal)}</small></li>)}</ul></details>}</td><td className="insight-money">{amount(sale.total_amount)}</td><td>{t(methodLabels[sale.payment_method])}</td><td>{sale.description || '—'}</td><td>{sale.created_by_name}</td></tr>)}</tbody></table></div>}
      </section>
      <ReturnActivity events={report.returns || []}/>
    </>}
  </div>
}

function ProfitSummary({ profit }) {
  const { t } = useLanguage()
  return <section className="insight-panel">
    <div className="insight-panel-heading"><div><h3>{t('Gross profit')}</h3><p>{t('Actual selling amount minus recorded purchase cost, before shop expenses.')}</p></div></div>
    <div className="payment-grid">
      <div className="payment-total"><span>{t('Net revenue with known cost')}</span><strong>{amount(profit.costedSalesAmount)}</strong></div>
      <div className="payment-total"><span>{t('Purchase cost')}</span><strong>{amount(profit.purchaseCost)}</strong></div>
      <div className="payment-total"><span>{t('Gross profit')}</span><strong>{amount(profit.grossProfit)}</strong></div>
    </div>
    {profit.missingCostTransactions > 0 && <p className="inventory-help" role="status">{t('{count} transactions have missing purchase costs and are excluded from profit.', { count: profit.missingCostTransactions })}</p>}
  </section>
}

function ReturnTotals({summary}){
  const {t}=useLanguage()
  return <section className="insight-panel"><div className="payment-grid"><div className="payment-total"><span>{t('Gross sales before returns')}</span><strong>{amount(summary.grossSalesAmount)}</strong></div><div className="payment-total"><span>{t('Return credits')}</span><strong>{amount(summary.returnsAmount)}</strong></div><div className="payment-total"><span>{t('Return transactions')}</span><strong>{summary.returnCount}</strong></div></div><p className="inventory-help">{t('Sales and payment totals are net of return credits on the return date. Original sales stay visible.')}</p></section>
}

function ReturnActivity({events}){
  const {t,locale}=useLanguage()
  return <section className="insight-panel"><div className="insight-panel-heading"><h3>{t('Returns and exchanges')}</h3></div>{events.length===0?<p className="insight-status">{t('No returns in this period.')}</p>:<div className="insight-table-wrap"><table className="insight-table"><thead><tr><th>{t('Return date')}</th><th>{t('Returned items')}</th><th>{t('Return credit')}</th><th>{t('Settlement (+collect / -refund)')}</th><th>{t('Return reason')}</th><th>{t('Recorded by')}</th></tr></thead><tbody>{events.map(value=><tr key={value.id}><td>{dateLabel(value.returnDate,locale)}<small className="insight-subtext">{t('Sale reference')}: {value.saleId}</small></td><td>{value.items.map((item,index)=><div key={index}>{item.itemName} × {item.quantity}<span className="insight-subtext">{t(item.condition)}</span></div>)}</td><td>{amount(value.creditAmount)}</td><td>{amount(value.settlementAmount)}<span className="insight-subtext">{t(methodLabels[value.settlementMethod])}</span>{value.replacementSaleId&&<small>{t('Replacement sale')}: {value.replacementSaleId}</small>}</td><td>{value.reason}</td><td>{value.recordedBy}</td></tr>)}</tbody></table></div>}</section>
}
