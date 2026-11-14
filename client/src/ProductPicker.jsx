import { useEffect, useState } from 'react'
import { useLanguage } from './language.jsx'

export const productLabel = product => [product.name, product.size, product.color].filter(Boolean).join(' / ')

export default function ProductPicker({ item, onChange, allowLegacy = false, refreshKey = 0 }) {
  const { t } = useLanguage()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState({ products: [], totalPages: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    fetch(`/api/inventory?${new URLSearchParams({ q: search, page, status: 'active' })}`, { signal: controller.signal, credentials: 'same-origin' })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error); return data })
      .then(setResult).catch(err => { if (err.name !== 'AbortError') setError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [search, page, refreshKey])
  const selected = result.products.find(product => product.id === item.productId)
  function choose(id) {
    const product = result.products.find(product => product.id === id)
    onChange(product ? { ...item, productId: id, itemName: productLabel(product), unitPrice: '' } : { ...item, productId: '', itemName: '' })
  }
  return <div className="product-picker">
    <label>{t('Find product')}<input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} placeholder={t('Search name, SKU or barcode')} /></label>
    <label>{t('Inventory product')}<select value={item.productId || ''} onChange={event => choose(event.target.value)} required={!allowLegacy} aria-busy={loading}>
      <option value="">{t(allowLegacy ? 'Legacy item (not stock tracked)' : 'Choose a product')}</option>
      {item.productId && !selected && <option value={item.productId}>{item.itemName}</option>}
      {result.products.map(product => <option key={product.id} value={product.id} disabled={product.stock === 0 && product.id !== item.productId}>{productLabel(product)} · {product.sku} · {t('Available')}: {product.stock}</option>)}
    </select></label>
    {allowLegacy && !item.productId && <label>{t('Item name')}<input value={item.itemName} maxLength={240} onChange={event => onChange({ ...item, itemName: event.target.value })} required /></label>}
    {selected && <span className="field-hint">{t('Available stock: {count}', { count: selected.stock })}</span>}
    {loading && <span className="field-hint" role="status">{t('Loading products…')}</span>}
    {error && <span className="sales-error" role="alert">{t(error)}</span>}
    {!loading && !error && result.products.length === 0 && <span className="field-hint">{t('No products found. Ask an admin to add stock in Inventory.')}</span>}
    {result.totalPages > 1 && <div className="picker-pages"><button type="button" disabled={page === 1 || loading} onClick={() => setPage(page - 1)}>{t('Previous page')}</button><span>{page} / {result.totalPages}</span><button type="button" disabled={page >= result.totalPages || loading} onClick={() => setPage(page + 1)}>{t('Next page')}</button></div>}
  </div>
}
