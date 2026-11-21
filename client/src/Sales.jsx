import { useLanguage } from './language.jsx'
import { Fragment, useEffect, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Pencil, Plus, X } from 'lucide-react'
import './sales.css'
import ProductPicker from './ProductPicker.jsx'
import Returns from './Returns.jsx'

async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.')
  return data
}

function todayLocal() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function formatSaleDate(value, locale) {
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${value}T00:00:00`))
}

function formatTime(value, locale) {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function formatAmount(value) {
  const negative=String(value).startsWith('-')
  const [whole, fractional = ''] = String(value).replace(/^-/,'').split('.')
  const grouped = whole.length > 3 ? `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}` : whole
  return `${negative?'-':''}₹${grouped}.${fractional.padEnd(2, '0')}`
}

function centsFromPrice(value) {
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
}

function formatCents(cents) {
  return formatAmount(`${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`)
}

function itemSubtotalCents(item) {
  const price = centsFromPrice(item.unitPrice)
  const quantity = Number(item.quantity)
  if (price === null || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999999) return null
  return price * BigInt(quantity)
}

function itemsTotalCents(items) {
  return items.reduce((total, item) => total + (itemSubtotalCents(item) ?? 0n), 0n)
}

function newItem() { return { itemName: '', productId: '', quantity: '1', unitPrice: '' } }

function itemSummary(items, t) {
  if (!items?.length) return t('Item details unavailable')
  const names = items.slice(0, 2).map(item => `${item.itemName} × ${item.quantity}`)
  if (items.length > 2) names.push(t('+{count} more', { count: items.length - 2 }))
  return names.join(', ')
}

const methods = [
  ['CASH', 'Cash'], ['UPI', 'UPI'], ['CARD', 'Card'], ['OTHER', 'Other'],
]
const methodLabel = method => methods.find(([key]) => key === method)?.[1] || method

export default function Sales({ user }) {
  const { t, locale } = useLanguage()
  const [form, setForm] = useState({ saleDate: todayLocal(), items: [newItem()], paymentMethod: 'CASH', description: '' })
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [sales, setSales] = useState([])
  const [loading, setLoading] = useState(true)
  const [fromInput, setFromInput] = useState('')
  const [toInput, setToInput] = useState('')
  const [filters, setFilters] = useState({ from: '', to: '' })
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [reload, setReload] = useState(0)
  const [editId, setEditId] = useState(null)
  const [editForm, setEditForm] = useState(null)
  const [changingId, setChangingId] = useState(null)
  const [returnId, setReturnId] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      const query = new URLSearchParams({ page: String(page) })
      if (filters.from) query.set('from', filters.from)
      if (filters.to) query.set('to', filters.to)
      try {
        const result = await request(`/sales?${query}`)
        if (!cancelled) { setSales(result.sales); setTotalPages(result.totalPages) }
      } catch (err) { if (!cancelled) { setSales([]); setTotalPages(0); setError(err.message) } }
      finally { if (!cancelled) setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [filters, page, reload])

  async function saveSale(event) {
    event.preventDefault()
    setSaving(true); setError(''); setMessage('')
    try {
      const result = await request('/sales', { method: 'POST', body: JSON.stringify({ ...form, items: form.items.map(item => ({ ...item, quantity: String(item.quantity) })), idempotencyKey }) })
      setMessage(result.duplicate ? 'This sale was already saved.' : 'Sale saved successfully.')
      setForm({ saleDate: todayLocal(), items: [newItem()], paymentMethod: 'CASH', description: '' })
      setIdempotencyKey(crypto.randomUUID())
      setPage(1); setReload(value => value + 1)
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  function applyFilters(event) {
    event.preventDefault()
    setError(''); setPage(1); setFilters({ from: fromInput, to: toInput })
  }

  function clearFilters() {
    setFromInput(''); setToInput(''); setPage(1); setFilters({ from: '', to: '' })
  }

  function beginEdit(sale) {
    setReturnId(null)
    setError(''); setMessage(''); setEditId(sale.id)
    setEditForm({ saleDate: sale.saleDate, items: sale.items.map(item => ({ ...item, quantity: String(item.quantity) })), legacy: sale.items.length === 0, paymentMethod: sale.paymentMethod, description: sale.description || '', reason: '' })
  }

  async function saveCorrection(event) {
    event.preventDefault()
    setChangingId(editId); setError(''); setMessage('')
    try {
      const { legacy, items, ...correction } = editForm
      await request(`/sales/${editId}`, { method: 'PATCH', body: JSON.stringify({ ...correction, ...(legacy && !items.length ? {} : { items: items.map(item => ({ itemName: item.itemName, productId: item.productId || null, quantity: String(item.quantity), unitPrice: item.unitPrice })) }) }) })
      setMessage('Sale correction saved with an audit record.')
      setEditId(null); setEditForm(null); setReload(value => value + 1)
    } catch (err) { setError(err.message) }
    finally { setChangingId(null) }
  }

  async function voidSale(sale) {
    if (!editForm?.reason?.trim()) { setError('Enter a reason before voiding this sale.'); return }
    const confirmation = sale.items.some(item => item.productId)
      ? 'Void the sale for {amount}? Its linked items will return to available stock. Use this only to reverse an incorrect sale.'
      : 'Void the sale for {amount}? It will remain in the sales history.'
    if (!window.confirm(t(confirmation, { amount: formatAmount(sale.totalAmount) }))) return
    setChangingId(sale.id); setError(''); setMessage('')
    try {
      await request(`/sales/${sale.id}/void`, { method: 'POST', body: JSON.stringify({ reason: editForm.reason }) })
      setMessage('Sale voided. The original entry and reason remain in the audit trail.')
      setEditId(null); setEditForm(null); setReload(value => value + 1)
    } catch (err) { setError(err.message) }
    finally { setChangingId(null) }
  }

  return <div className="sales-workspace">
    {(message || error) && <p className={error ? 'sales-error' : 'sales-success'} role={error ? 'alert' : 'status'}>{t(error || message)}</p>}
    <section className="sale-entry-card" aria-labelledby="sale-entry-title">
      <div className="sales-section-title"><span className="sales-title-icon"><Plus size={18} /></span><div><p className="eyebrow">{t("DAILY RECORD")}</p><h2 id="sale-entry-title">{t("Add a sale")}</h2></div></div>
      <p className="sale-help">{t('Select products from inventory. Saving a sale reduces the available quantities automatically.')}</p>
      <form className="sale-form" onSubmit={saveSale}>
        <label>{t("Sale date")}<input type="date" value={form.saleDate} onChange={event => setForm({ ...form, saleDate: event.target.value })} required /></label>
        <label>{t("Payment method")}<select value={form.paymentMethod} onChange={event => setForm({ ...form, paymentMethod: event.target.value })}>{methods.map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}</select></label>
        <div className="sale-items-editor">
          <div className="items-editor-heading"><div><h3>{t("Purchase items")}</h3><p>{t("Enter the quantity and selling price for each item.")}</p></div><button type="button" className="add-item-button" onClick={() => setForm({ ...form, items: [...form.items, newItem()] })}><Plus size={15} /> {t("Add item")}</button></div>
          <div className="item-list">{form.items.map((item, index) => {
            const subtotal = itemSubtotalCents(item)
            return <div className="item-row" key={index}>
              <div className="item-name-field"><ProductPicker item={item} refreshKey={reload} onChange={value => setForm({ ...form, items: form.items.map((line, lineIndex) => lineIndex === index ? value : line) })} /></div>
              <label>{t("Quantity")}<input type="number" inputMode="numeric" min="1" max="999999" step="1" value={item.quantity} onChange={event => setForm({ ...form, items: form.items.map((line, lineIndex) => lineIndex === index ? { ...line, quantity: event.target.value } : line) })} required /></label>
              <label>{t('Negotiated selling rate')}<div className="amount-input"><span aria-hidden="true">₹</span><input type="text" inputMode="decimal" pattern="[0-9]{1,10}(\.[0-9]{1,2})?" value={item.unitPrice} onChange={event => setForm({ ...form, items: form.items.map((line, lineIndex) => lineIndex === index ? { ...line, unitPrice: event.target.value } : line) })} placeholder="0.00" maxLength={13} required /></div></label>
              <div className="item-subtotal"><span>{t("Subtotal")}</span><strong>{subtotal === null ? '—' : formatCents(subtotal)}</strong></div>
              <button type="button" className="remove-item-button" onClick={() => setForm({ ...form, items: form.items.filter((_, lineIndex) => lineIndex !== index) })} aria-label={t('Remove item {number}', { number: index + 1 })} title={t("Remove item")}><X size={16} /></button>
            </div>
          })}</div>
          {form.items.length === 0 && <p className="no-items-message">{t("Add at least one item before saving this sale.")}</p>}
          <div className="sale-total-row"><span>{t("Total sale amount")}</span><strong>{formatCents(itemsTotalCents(form.items))}</strong></div>
        </div>
        <div className="sale-submit-row"><button className="save-sale-button" type="submit" disabled={saving || form.items.length === 0 || itemsTotalCents(form.items) <= 0n}>{saving ? <><span className="spinner" /> {t("Saving…")}</> : <><Check size={17} /> {t("Save sale")}</>}</button><span className="sale-secure-note">{t("Total is calculated from the item rows and stored exactly to the paisa.")}</span></div>
      </form>
    </section>

    <section className="sales-history" aria-labelledby="history-title">
      <div className="history-heading"><div><p className="eyebrow">{t("RECENT RECORDS")}</p><h2 id="history-title">{t("Sales history")}</h2><p className="history-subtitle">{user.role === 'ADMIN' ? t("All staff entries") : t("Your recorded sales")}</p></div></div>
      <form className="date-filter" onSubmit={applyFilters}>
        <label>{t("From")}<input type="date" value={fromInput} max={toInput || undefined} onChange={event => setFromInput(event.target.value)} /></label>
        <label>{t("To")}<input type="date" value={toInput} min={fromInput || undefined} onChange={event => setToInput(event.target.value)} /></label>
        <button type="submit" className="filter-button">{t("Filter dates")}</button>
        {(filters.from || filters.to) && <button type="button" className="clear-filter" onClick={clearFilters}>{t("Clear")}</button>}
      </form>
      <div className="sales-table-wrap">
        <table className="sales-table">
          <thead><tr><th>{t("Date & time")}</th><th>{t("Items")}</th><th>{t("Sale amount")}</th>{user.role === 'ADMIN' && <th>{t('Gross profit')}</th>}<th>{t("Payment")}</th><th>{t("Description")}</th><th>{t("Recorded by")}</th>{user.role === 'ADMIN' && <th>{t("Actions")}</th>}</tr></thead>
          <tbody>
            {loading ? <tr><td className="table-message" colSpan={user.role === 'ADMIN' ? 8 : 6}>{t("Loading sales…")}</td></tr> : sales.length === 0 ? <tr><td className="table-message" colSpan={user.role === 'ADMIN' ? 8 : 6}>{t("No sales found for this date range.")}</td></tr> : sales.map(sale => <Fragment key={sale.id}>
              <tr className={sale.voidedAt ? 'voided-sale' : ''}>
                <td><strong>{formatSaleDate(sale.saleDate, locale)}</strong><span className="table-subtext">{formatTime(sale.createdAt, locale)}</span></td><td><span className="item-summary">{itemSummary(sale.items, t)}</span>{sale.items?.length > 0 && <details className="item-details"><summary>{t(sale.items.length === 1 ? 'View item' : 'View items')}</summary><ul>{sale.items.map((item, itemIndex) => <li key={itemIndex}><span>{item.itemName} × {item.quantity}</span><small>{formatAmount(item.unitPrice)} {t("each ·")} {formatAmount(item.subtotal)}</small></li>)}</ul></details>}</td>
                <td><strong className="sale-amount">{formatAmount(sale.totalAmount)}</strong>{sale.hasReturns && <span className="table-subtext">{t('Return credit')}: {formatAmount(sale.refundedAmount)}</span>}{sale.voidedAt && <span className="void-badge">{t("Voided")}</span>}</td>
                {user.role === 'ADMIN' && <td>{sale.voidedAt ? '\u2014' : sale.grossProfit == null ? t('Cost unavailable') : formatAmount(sale.grossProfit)}</td>}<td>{t(methodLabel(sale.paymentMethod))}</td><td className="sale-description">{sale.description || '—'}</td><td>{sale.createdByName}</td>
                {user.role === 'ADMIN' && <td><div className="sale-action-group">{!sale.voidedAt ? <>{!sale.hasReturns && !sale.isExchangeReplacement ? <button className="edit-sale-button" type="button" onClick={() => beginEdit(sale)}><Pencil size={14} /> {t("Edit / void")}</button> : <span className="table-subtext">{t('Locked: return / exchange history')}</span>}{sale.items.length>0 && <button className="edit-sale-button" type="button" onClick={()=>{setReturnId(sale.id);setEditId(null);setEditForm(null)}}>{t('Return / exchange')}</button>}</> : <span className="table-subtext">{sale.voidedByName ? t('Voided by {name}', { name: sale.voidedByName }) : t("Voided")}</span>}</div></td>}
              </tr>
              {user.role==='ADMIN' && returnId===sale.id && <tr className="edit-row"><td colSpan={8}><Returns sale={sale} onClose={()=>setReturnId(null)} onSaved={()=>{setReturnId(null);setMessage('Return recorded successfully.');setReload(value=>value+1)}}/></td></tr>}
              {user.role === 'ADMIN' && editId === sale.id && editForm && <tr className="edit-row"><td colSpan={8}><form className="correction-form" onSubmit={saveCorrection}>
                <div className="correction-heading"><strong>{t("Correct sale")}</strong><button type="button" className="icon-close" onClick={() => { setEditId(null); setEditForm(null) }} aria-label={t("Cancel correction")}><X size={17} /></button></div>
                {editForm.legacy && <p className="legacy-items-note">{t("This older sale has no item details. Its original total is preserved; add items below if you want to convert it to item-level details.")}</p>}
                <div className="correction-items">{editForm.items.map((item, index) => {
                  const subtotal = itemSubtotalCents(item)
                  return <div className="item-row" key={index}>
                    <div className="item-name-field">{sale.items.some(line => line.productId) ? <ProductPicker item={item} refreshKey={reload} onChange={value => setEditForm({ ...editForm, items: editForm.items.map((line, i) => i === index ? value : line) })} /> : <label>{t('Item name')}<input value={item.itemName} onChange={event => setEditForm({ ...editForm, legacy: false, items: editForm.items.map((line, i) => i === index ? { ...line, itemName: event.target.value } : line) })} maxLength={240} required /></label>}</div>
                    <label>{t("Quantity")}<input type="number" min="1" max="999999" step="1" value={item.quantity} onChange={event => setEditForm({ ...editForm, legacy: false, items: editForm.items.map((line, i) => i === index ? { ...line, quantity: event.target.value } : line) })} required /></label>
                    <label>{t('Negotiated selling rate')}<div className="amount-input"><span aria-hidden="true">₹</span><input type="text" inputMode="decimal" pattern="[0-9]{1,10}(\.[0-9]{1,2})?" value={item.unitPrice} onChange={event => setEditForm({ ...editForm, legacy: false, items: editForm.items.map((line, i) => i === index ? { ...line, unitPrice: event.target.value } : line) })} required /></div></label>
                    <div className="item-subtotal"><span>{t("Subtotal")}</span><strong>{subtotal === null ? '—' : formatCents(subtotal)}</strong></div>
              <button type="button" className="remove-item-button" disabled={editForm.items.length <= 1} onClick={() => setEditForm({ ...editForm, legacy: false, items: editForm.items.filter((_, i) => i !== index) })} aria-label={t('Remove corrected item {number}', { number: index + 1 })}><X size={16} /></button>
                  </div>
                })}
                  {editForm.items.length === 0 && <p className="no-items-message">{t("No item details. Add a row to attach details to this legacy sale.")}</p>}
                  <button type="button" className="add-item-button correction-add-item" onClick={() => setEditForm({ ...editForm, legacy: false, items: [...editForm.items, newItem()] })}><Plus size={14} /> {t("Add item")}</button>
                  {editForm.items.length > 0 && <div className="sale-total-row correction-total"><span>{t("Calculated sale total")}</span><strong>{formatCents(itemsTotalCents(editForm.items))}</strong></div>}
                </div>
                <div className="correction-fields">
                  <label>{t("Date")}<input type="date" value={editForm.saleDate} onChange={event => setEditForm({ ...editForm, saleDate: event.target.value })} required /></label>
                  <label>{t("Payment")}<select value={editForm.paymentMethod} onChange={event => setEditForm({ ...editForm, paymentMethod: event.target.value })}>{methods.map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}</select></label>
                  <label>{t("Description")}<input value={editForm.description} onChange={event => setEditForm({ ...editForm, description: event.target.value })} maxLength={250} /></label>
                  <label className="reason-field">{t("Correction / void reason")}<input value={editForm.reason} onChange={event => setEditForm({ ...editForm, reason: event.target.value })} minLength={3} maxLength={300} required placeholder={t("Why is this entry being changed?")} /></label>
                </div>
                <div className="correction-actions"><button className="save-correction-button" type="submit" disabled={changingId === sale.id}>{changingId === sale.id ? t("Saving…") : t("Save correction")}</button><button className="void-sale-button" type="button" disabled={changingId === sale.id} onClick={() => voidSale(sale)}>{t("Void sale")}</button></div>
              </form></td></tr>}
            </Fragment>) }
          </tbody>
        </table>
      </div>
      <div className="pagination"><span>{t('Page {page} of {total}', { page, total: Math.max(totalPages, 1) })}</span><div><button type="button" aria-label={t("Previous page")} disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}><ChevronLeft size={17} /></button><button type="button" aria-label={t("Next page")} disabled={page >= totalPages || loading} onClick={() => setPage(page + 1)}><ChevronRight size={17} /></button></div></div>
    </section>
  </div>
}
