import { useEffect, useId, useState } from 'react'
import { useLanguage } from './language.jsx'

export const productLabel = product => [product.name, product.size, product.color].filter(Boolean).join(' / ')

function purchaseRateLabel(value) {
  const [whole, fraction = ''] = String(value).split('.')
  const cents = (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0')) + 5000n) / 10000n
  return `₹${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
}

export default function ProductPicker({ item, onChange, allowLegacy = false, refreshKey = 0, allowCostSearch = false }) {
  const { t } = useLanguage()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState({ products: [], totalPages: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [chosenProduct, setChosenProduct] = useState(null)
  const inputId = useId()
  const listId = `${inputId}-products`
  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, listId])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setActive(-1)
    fetch(`/api/inventory?${new URLSearchParams({ q: search, page, status: 'active' })}`, { signal: controller.signal, credentials: 'same-origin' })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error); return data })
      .then(data => { if (!controller.signal.aborted) setResult(data) }).catch(err => { if (err.name !== 'AbortError') setError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [search, page, refreshKey])
  const selected = result.products.find(product => product.id === item.productId) || (chosenProduct?.id === item.productId ? chosenProduct : null)
  function choose(product) {
    setChosenProduct(product)
    onChange(product ? { ...item, productId: product.id, itemName: productLabel(product), unitPrice: '' } : { ...item, productId: '', itemName: '' })
    setOpen(false); setSearch(''); setPage(1); setActive(-1)
  }
  function searchProducts(value) {
    setSearch(value); setPage(1); setOpen(true); setActive(-1); setLoading(true)
    // Unselected search text must never submit the previously selected product.
    if (item.productId) onChange({ ...item, productId: '', itemName: '' })
  }
  function handleKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return }
    if (event.key === 'Enter' && open) {
      event.preventDefault()
      const product = result.products[active]
      if (!loading && !error && product && (product.stock > 0 || product.id === item.productId)) choose(product)
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setOpen(true)
      if (loading || error) return
      const direction = event.key === 'ArrowDown' ? 1 : -1
      let index = active < 0 && direction < 0 ? 0 : active
      for (let count = 0; count < result.products.length; count++) {
        index = (index + direction + result.products.length) % result.products.length
        const product = result.products[index]
        if (product.stock > 0 || product.id === item.productId) { setActive(index); break }
      }
    }
  }
  return <div className="product-picker">
    <div className="product-combobox" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setSearch('') } }}>
      <label htmlFor={inputId}>{t('Inventory product')}</label>
      <input id={inputId} role="combobox" autoComplete="off" aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-activedescendant={open && !loading && active >= 0 ? `${listId}-${active}` : undefined} aria-busy={loading} value={open ? search : item.productId ? item.itemName : ''} onFocus={() => setOpen(true)} onChange={event => searchProducts(event.target.value)} onKeyDown={handleKey} placeholder={t(allowCostSearch ? 'Search name, SKU, barcode or purchase rate' : 'Search name, SKU or barcode')} maxLength={100} required={!allowLegacy} />
      {open && <div className="product-results">
        {loading && <p className="picker-status" role="status">{t('Loading products…')}</p>}
        {error && <p className="sales-error" role="alert">{t(error)}</p>}
        <div id={listId} role="listbox" aria-label={t('Inventory product')}>
          {!loading && !error && result.products.map((product, index) => <button id={`${listId}-${index}`} type="button" role="option" aria-selected={product.id === item.productId} className={`product-option${active === index ? ' product-option-active' : ''}`} key={product.id} disabled={product.stock === 0 && product.id !== item.productId} onMouseDown={event => event.preventDefault()} onClick={() => choose(product)}>
            <strong>{productLabel(product)}</strong><span>{product.sku} · {t('Available')}: {product.stock}</span>
            {allowCostSearch && product.purchaseRate != null && <span>{t('Purchase rate')}: {purchaseRateLabel(product.purchaseRate)}</span>}
          </button>)}
        </div>
        {!loading && !error && result.products.length === 0 && <p className="picker-status" role="status">{t('No products found. Ask an admin to add stock in Inventory.')}</p>}
        {!loading && !error && result.totalPages > 1 && <div className="picker-pages"><button type="button" disabled={page === 1} onClick={() => { setLoading(true); setPage(page - 1) }}>{t('Previous page')}</button><span>{page} / {result.totalPages}</span><button type="button" disabled={page >= result.totalPages} onClick={() => { setLoading(true); setPage(page + 1) }}>{t('Next page')}</button></div>}
      </div>}
    </div>
    {allowCostSearch && <span className="field-hint">{t('Type a purchase rate, for example 250 or 250.50, to find matching products. Uses current average purchase cost rounded to two decimals.')}</span>}
    {item.productId && <button className="clear-product" type="button" onClick={() => choose(null)}>{t(allowLegacy ? 'Legacy item (not stock tracked)' : 'Clear product')}</button>}
    {allowLegacy && !item.productId && <label>{t('Item name')}<input value={item.itemName} maxLength={240} onChange={event => onChange({ ...item, itemName: event.target.value })} required /></label>}
    {selected && <><span className="field-hint">SKU: <strong>{selected.sku}</strong></span><span className="field-hint">{t('Available stock: {count}', { count: selected.stock })}</span></>}
  </div>
}
