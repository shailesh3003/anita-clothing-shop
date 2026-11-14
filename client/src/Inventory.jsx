import { useEffect, useRef, useState } from 'react'
import { Package, Plus, RefreshCw, X } from 'lucide-react'
import { useLanguage } from './language.jsx'
import { productLabel } from './ProductPicker.jsx'
import './inventory.css'

async function request(path, options = {}) {
  const response = await fetch(`/api/inventory${path}`, { ...options, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.')
  return data
}
function costLabel(value) {
  const negative = value.startsWith('-')
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const micros = BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'))
  const cents = (micros+5000n)/10000n
  return (negative ? '-' : '')+'₹'+(cents/100n)+'.'+String(cents%100n).padStart(2,'0')
}
const shopToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
const purchaseDateLabel=(value,locale)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone:'Asia/Kolkata'}).format(new Date(`${value}T00:00:00+05:30`))
const blankProduct = () => ({ name: '', sku: '', size: '', color: '', barcode: '', purchaseRate: '', purchaseDate:shopToday(), openingStock: '0', reorderLevel: '5', requestKey: crypto.randomUUID() })

function ProductFields({ form, setForm, editing, t }) {
  function field(key, label, options = {}) {
    return <label>{t(label)}<input value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })} {...options} /></label>
  }
  return <div className="inventory-fields">
    {field('name', 'Product name', { required: true, maxLength: 100 })}
    {field('sku', 'SKU (unique item code)', { required: true, maxLength: 50 })}
    {field('size', 'Size (optional)', { maxLength: 30 })}
    {field('color', 'Colour (optional)', { maxLength: 40 })}
    {field('barcode', 'Barcode (optional)', { maxLength: 80 })}
    {field('purchaseRate', 'Purchase rate / average cost (INR)', { required: true, inputMode: 'decimal', pattern: '[0-9]{1,10}(\\.[0-9]{1,6})?', maxLength: 17 })}
    {field('reorderLevel', 'Low-stock threshold', { required: true, type: 'number', min: 0, max: 999999999, step: 1 })}
    {!editing && field('openingStock', 'Opening physical stock', { required: true, type: 'number', min: 0, max: 999999999, step: 1 })}
    {!editing && Number(form.openingStock)>0 && field('purchaseDate','Stock purchase date',{required:true,type:'date',max:shopToday()})}
    {editing && <label>{t('Status')}<select value={String(form.isActive)} onChange={event => setForm({ ...form, isActive: event.target.value === 'true' })}><option value="true">{t('Active')}</option><option value="false">{t('Archived')}</option></select></label>}
  </div>
}

export default function Inventory({ user }) {
  const { t, locale } = useLanguage()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('active')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [data, setData] = useState({ products: [], totalPages: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState(null)
  const [selected, setSelected] = useState(null)
  const [adjustment, setAdjustment] = useState(null)
  const [lifecycle, setLifecycle] = useState(null)
  const [saving, setSaving] = useState(false)
  const submitting = useRef(false)
  const [history, setHistory] = useState(null)
  const [historyPage, setHistoryPage] = useState(1)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const isAdmin = user.role === 'ADMIN'

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    request(`?${new URLSearchParams({ q: search, status, page })}`, { signal: controller.signal })
      .then(setData).catch(err => { if (err.name !== 'AbortError') setError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [search, status, page, reload])

  const historyId = history?.product.id
  useEffect(() => {
    if (!historyId) return
    const controller = new AbortController()
    setHistoryLoading(true); setHistoryError('')
    request(`/${historyId}/movements?page=${historyPage}`, { signal: controller.signal })
      .then(value => setHistory(previous => ({ ...previous, ...value })))
      .catch(err => { if (err.name !== 'AbortError') setHistoryError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setHistoryLoading(false) })
    return () => controller.abort()
  }, [historyId, historyPage, reload])

  function closeEditor() { setForm(null); setSelected(null); setAdjustment(null); setLifecycle(null) }
  async function save(event) {
    event.preventDefault()
    if (submitting.current) return
    if (lifecycle && !window.confirm(t(lifecycle.action === 'remove' ? 'Remove {name} ({sku})? Items with sales history will be archived. Removed items can be restored.' : 'Restore {name} ({sku}) to archived inventory for review?', { name: productLabel(selected), sku: selected.sku }))) return
    submitting.current = true; setSaving(true); setError(''); setNotice('')
    try {
      if (lifecycle) {
        const result = await request(`/${selected.id}/${lifecycle.action}`, { method: 'POST', body: JSON.stringify({ reason: lifecycle.reason, version: selected.version }) })
        setNotice(result.outcome === 'REMOVED' ? 'Item removed. You can restore it from Removed items.' : result.outcome === 'ARCHIVED' ? 'This item has sales history and was archived instead. Its records are preserved.' : 'Item restored to Archived. Review its stock and activate it when ready.')
        setStatus(result.outcome === 'REMOVED' ? 'removed' : 'archived'); setPage(1)
      } else if (adjustment) {
        await request(`/${selected.id}/adjustments`, { method: 'POST', body: JSON.stringify({ ...adjustment, quantity: Number(adjustment.quantity), expectedVersion: selected.version }) })
        setNotice('Stock updated successfully.')
      } else {
        await request(selected ? `/${selected.id}` : '', { method: selected ? 'PATCH' : 'POST', body: JSON.stringify({ ...form, openingStock: Number(form.openingStock || 0), reorderLevel: Number(form.reorderLevel) }) })
        setNotice('Product saved successfully.')
      }
      closeEditor(); setReload(value => value + 1)
    } catch (err) { setError(err.message) }
    finally { submitting.current = false; setSaving(false) }
  }

  function refresh() { closeEditor(); setReload(value => value + 1) }
  const editor = form || adjustment || lifecycle
  return <div className="inventory-page">
    <div className="inventory-heading"><div><p className="eyebrow">{t('STOCK CONTROL')}</p><h2><Package size={22} />{t('Inventory')}</h2><p>{t('Track each size and colour separately. Sales reduce stock automatically.')}</p></div><div className="inventory-actions"><button type="button" onClick={refresh} disabled={saving}><RefreshCw size={16} />{t('Refresh')}</button>{isAdmin && <button type="button" className="inventory-primary" disabled={saving} onClick={() => { closeEditor(); setForm(blankProduct()); setError(''); setNotice('') }}><Plus size={16} />{t('Add product')}</button>}</div></div>
    {(error || notice) && <p className={error ? 'sales-error' : 'sales-success'} role={error ? 'alert' : 'status'}>{t(error || notice)}</p>}
    {editor && <form className="inventory-panel" onSubmit={save}>
      <div className="inventory-panel-heading"><h3>{t(lifecycle ? lifecycle.action === 'remove' ? 'Remove item' : 'Restore item' : adjustment ? 'Adjust stock' : selected ? 'Edit product' : 'Add product')}</h3><button type="button" disabled={saving} onClick={closeEditor} aria-label={t('Close')}><X size={18} /></button></div>
      {lifecycle ? <><p><strong>{productLabel(selected)}</strong> · {selected.sku}</p><p className="inventory-help">{t(lifecycle.action === 'remove' ? 'Never-sold items move to Removed items. Items with any sales history are archived. Stock and history are retained.' : 'Restored items stay archived until you review the quantity and activate them. No stock is added or deducted.')}</p><label className="inventory-reason">{t('Reason')}<input value={lifecycle.reason} onChange={event => setLifecycle({ ...lifecycle, reason: event.target.value })} minLength={3} maxLength={300} required autoFocus /></label></> : adjustment ? <><p><strong>{productLabel(selected)}</strong> · {selected.sku} · {t('Available')}: {selected.stock}</p><div className="inventory-fields">
        <label>{t('Stock action')}<select value={adjustment.kind} onChange={event => setAdjustment({ ...adjustment, kind: event.target.value, quantity: '' })}><option value="RECEIPT">{t('Receive new stock')}</option><option value="DAMAGE">{t('Remove damaged or lost stock')}</option><option value="COUNT">{t('Set physical count')}</option></select></label>
        <label>{t(adjustment.kind === 'COUNT' ? 'Actual quantity counted' : 'Quantity')}<input type="number" min={adjustment.kind === 'COUNT' ? 0 : 1} max={999999999} step="1" value={adjustment.quantity} onChange={event => setAdjustment({ ...adjustment, quantity: event.target.value })} required /></label>
        {adjustment.kind === 'RECEIPT' && <label>{t('Supplier purchase rate per item (INR)')}<input value={adjustment.purchaseRate || ''} inputMode="decimal" pattern="[0-9]{1,10}(\.[0-9]{1,2})?" required onChange={event => setAdjustment({ ...adjustment, purchaseRate: event.target.value })} /></label>}
        {adjustment.kind === 'RECEIPT' && <label>{t('Stock purchase date')}<input type="date" max={shopToday()} value={adjustment.purchaseDate || ''} onChange={event=>setAdjustment({...adjustment,purchaseDate:event.target.value})} required/></label>}
        <label className="inventory-wide">{t('Reason / delivery reference')}<input value={adjustment.reason} minLength={3} maxLength={300} onChange={event => setAdjustment({ ...adjustment, reason: event.target.value })} required /></label></div><p className="inventory-help">{t('A physical count replaces the recorded balance. Refresh and recount if another sale changes stock.')}</p></> : <><p className="inventory-help">{t('Use a different SKU for each size and colour. Opening stock must be the quantity physically available now, not past purchases.')}</p><ProductFields form={form} setForm={setForm} editing={!!selected} t={t} /></>}
      <button className="inventory-primary" disabled={saving}>{t(saving ? 'Saving…' : lifecycle ? lifecycle.action === 'remove' ? 'Confirm removal' : 'Confirm restore' : 'Save changes')}</button>
    </form>}
    {isAdmin && <p className="inventory-help">{t('Purchase rates are private. Enter the negotiated selling rate during each sale. Delivery rates update the weighted average cost; past sales keep their recorded cost.')}</p>}
    <section className="inventory-panel">
      <div className="inventory-filters"><label>{t('Find product')}<input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} placeholder={t('Search name, SKU or barcode')} /></label><label>{t('Stock filter')}<select value={status} onChange={event => { setStatus(event.target.value); setPage(1) }}><option value="active">{t('Active')}</option><option value="low">{t('Low stock')}</option><option value="archived">{t('Archived')}</option><option value="all">{t('All products')}</option>{isAdmin && <option value="removed">{t('Removed items')}</option>}</select></label></div>
      <p className="inventory-help">{t('Sold quantities include valid linked sales only, starting when inventory tracking began.')}</p>
      <div className="inventory-table-wrap"><table className="inventory-table"><thead><tr><th>{t('Product / SKU')}</th><th>{t('Available')}</th><th>{t('Sold')}</th><th>{t('Last purchase date')}</th>{isAdmin && <><th>{t('Purchase rate / average cost (INR)')}</th><th>{t('Gross profit')}</th></>}<th>{t('Low-stock threshold')}</th>{isAdmin && <th>{t('Actions')}</th>}</tr></thead><tbody>
        {loading ? <tr><td colSpan={isAdmin ? 8 : 5}>{t('Loading products…')}</td></tr> : data.products.length === 0 ? <tr><td colSpan={isAdmin ? 8 : 5}>{t('No products found. Ask an admin to add stock in Inventory.')}</td></tr> : data.products.map(product => <tr key={product.id}><td><strong>{productLabel(product)}</strong><small>{product.sku}{product.barcode ? ` · ${product.barcode}` : ''}</small>{!product.isActive && <span className="stock-badge">{t(product.isRemoved ? 'Removed' : 'Archived')}</span>}{product.isRemoved && <small>{t('Removal reason')}: {product.removalReason}</small>}</td><td><strong>{product.stock}</strong>{product.isActive && product.stock <= product.reorderLevel && <span className={`stock-badge ${product.stock === 0 ? 'stock-empty' : 'stock-low'}`}>{t(product.stock === 0 ? 'Out of stock' : 'Low stock')}</span>}</td><td>{product.soldQuantity}{product.damagedReturns>0 && <small>{t('Damaged returns (total)')}: {product.damagedReturns}</small>}</td><td>{product.lastPurchaseDate ? purchaseDateLabel(product.lastPurchaseDate,locale) : t('Not recorded')}</td>{isAdmin && <><td>{product.purchaseRate == null ? t('Cost unavailable') : costLabel(product.purchaseRate)}</td><td>{costLabel(product.grossProfit)}{product.missingCostUnits > 0 && <small>{t('Cost unavailable')}: {product.missingCostUnits} {t('items')}</small>}</td></>}<td>{product.reorderLevel}</td>{isAdmin && <td><div className="inventory-row-actions"><button type="button" disabled={saving || product.isRemoved} onClick={() => { closeEditor(); setSelected(product); setForm({ ...product, purchaseRate: product.purchaseRate ?? '' }) }}>{t('Edit product')}</button><button type="button" disabled={saving || !product.isActive} onClick={() => { closeEditor(); setSelected(product); setAdjustment({ kind: 'RECEIPT', purchaseDate:shopToday(), quantity: '', reason: '', requestKey: crypto.randomUUID() }) }}>{t('Adjust stock')}</button><button type="button" onClick={() => { setHistory({ product, movements: [] }); setHistoryPage(1) }}>{t('Movement history')}</button><button type="button" className={product.isRemoved ? '' : 'inventory-remove'} disabled={saving} onClick={() => { closeEditor(); setSelected(product); setLifecycle({ action: product.isRemoved ? 'restore' : 'remove', reason: '' }); setError(''); setNotice('') }}>{t(product.isRemoved ? 'Restore item' : 'Remove item')}</button></div></td>}</tr>)}
      </tbody></table></div>
      <div className="pagination"><span>{t('Page {page} of {total}', { page, total: Math.max(data.totalPages, 1) })}</span><div><button type="button" disabled={page === 1 || loading} onClick={() => setPage(page - 1)}>{t('Previous page')}</button><button type="button" disabled={page >= data.totalPages || loading} onClick={() => setPage(page + 1)}>{t('Next page')}</button></div></div>
    </section>
    {history && <section className="inventory-panel"><div className="inventory-panel-heading"><h3>{t('Movement history')}: {productLabel(history.product)}</h3><button type="button" onClick={() => setHistory(null)} aria-label={t('Close')}><X size={18} /></button></div>
      {historyError && <p className="sales-error" role="alert">{t(historyError)}</p>}
      {historyLoading ? <p role="status">{t('Loading products…')}</p> : <div className="inventory-table-wrap"><table className="inventory-table"><thead><tr><th>{t('Recorded at')}</th><th>{t('Purchase date')}</th><th>{t('Stock action')}</th><th>{t('Change')}</th><th>{t('Balance')}</th><th>{t('Delivery rate / average cost')}</th><th>{t('Reason / delivery reference')}</th><th>{t('Recorded by')}</th></tr></thead><tbody>{history.movements.length === 0 ? <tr><td colSpan={8}>{t('No stock movements found.')}</td></tr> : history.movements.map(movement => <tr key={movement.id}><td>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(movement.createdAt))}</td><td>{movement.purchaseDate ? purchaseDateLabel(movement.purchaseDate,locale) : ['OPENING','RECEIPT'].includes(movement.kind) ? t('Not recorded') : '\u2014'}</td><td>{t(movement.kind)}{movement.saleId && <small>{t('Sale reference')}: {movement.saleId}</small>}</td><td>{movement.delta > 0 ? '+' : ''}{movement.delta}</td><td>{movement.balance}</td><td>{movement.purchaseRate == null ? '\u2014' : costLabel(movement.purchaseRate)} / {movement.averageCost == null ? t('Cost unavailable') : costLabel(movement.averageCost)}</td><td>{movement.reason}</td><td>{movement.actor}</td></tr>)}</tbody></table></div>}
      <div className="pagination"><span>{historyPage}</span><div><button type="button" disabled={historyPage === 1 || historyLoading} onClick={() => setHistoryPage(historyPage - 1)}>{t('Previous page')}</button><button type="button" disabled={!history.hasMore || historyLoading} onClick={() => setHistoryPage(historyPage + 1)}>{t('Next page')}</button></div></div>
    </section>}
  </div>
}
