import { useEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { useLanguage } from './language.jsx'
import ProductPicker from './ProductPicker.jsx'
import './returns.css'

const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
const cents=value=>{if(!/^\d{1,10}(?:\.\d{1,2})?$/.test(String(value)))return 0n;const [whole,fraction='']=String(value).split('.');return BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'))}
function money(value){const abs=value<0n?-value:value;return `${value<0n?'-':''}₹${abs/100n}.${String(abs%100n).padStart(2,'0')}`}
const freshItem=()=>({itemName:'',productId:'',quantity:'1',unitPrice:''})
const wholeQuantity=value=>Number.isSafeInteger(Number(value))&&Number(value)>=0&&Number(value)<=999999?Number(value):0
const conditions=['SELLABLE','DAMAGED','QUARANTINE']

export default function Returns({sale,onClose,onSaved}){
  const {t,locale}=useLanguage()
  const [lines,setLines]=useState(()=>sale.items.map(item=>({saleItemId:item.id,quantity:'0',condition:item.productId?'SELLABLE':'QUARANTINE'})))
  const [date,setDate]=useState(today)
  const [reason,setReason]=useState('')
  const [method,setMethod]=useState(sale.paymentMethod)
  const [exchange,setExchange]=useState(false)
  const [replacement,setReplacement]=useState([freshItem()])
  const [history,setHistory]=useState([])
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [saving,setSaving]=useState(false)
  const [requestKey]=useState(()=>crypto.randomUUID())
  const submitting=useRef(false)
  useEffect(()=>{
    const controller=new AbortController()
    fetch(`/api/returns/${sale.id}`,{credentials:'same-origin',signal:controller.signal})
      .then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error);return data})
      .then(data=>setHistory(data.returns)).catch(err=>{if(err.name!=='AbortError')setError(err.message)})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false)})
    return()=>controller.abort()
  },[sale.id])
  const credit=lines.reduce((sum,line,index)=>sum+cents(sale.items[index].unitPrice)*BigInt(wholeQuantity(line.quantity)),0n)
  const total=exchange?replacement.reduce((sum,item)=>sum+cents(item.unitPrice)*BigInt(wholeQuantity(item.quantity)),0n):0n
  const difference=total-credit
  function updateLine(index,change){setLines(lines.map((line,i)=>i===index?{...line,...change}:line))}
  async function submit(event){
    event.preventDefault()
    if(submitting.current)return
    const items=lines.filter(line=>Number(line.quantity)>0).map(line=>({...line,quantity:Number(line.quantity)}))
    if(!items.length){setError('Choose at least one item to return.');return}
    if(!window.confirm(t('Confirm this return after checking the goods and refund/payment? This record cannot be edited or voided.')))return
    submitting.current=true;setSaving(true);setError('')
    try{
      const response=await fetch(`/api/returns/${sale.id}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({returnDate:date,reason,settlementMethod:method,requestKey,items,...(exchange?{replacementItems:replacement.map(item=>({...item,quantity:String(item.quantity)}))}:{})})})
      const data=await response.json()
      if(!response.ok)throw new Error(data.error || 'Something went wrong. Please try again.')
      onSaved()
    }catch(err){setError(err.message)}finally{submitting.current=false;setSaving(false)}
  }
  return <section className="return-panel">
    <div className="correction-heading"><strong>{t('Returns and exchanges')}</strong><button type="button" className="icon-close" onClick={onClose} disabled={saving} aria-label={t('Close')}><X size={18}/></button></div>
    <p className="return-help">{t('Refunds use the original bargained rate. Only sellable goods return to available stock. Confirm the physical refund or payment separately; this app records it without transferring money.')}</p>
    {error&&<p className="sales-error" role="alert">{t(error)}</p>}
    <form onSubmit={submit}>
      <div className="return-table-wrap"><table className="return-table"><thead><tr><th>{t('Item name')}</th><th>{t('Original selling rate')}</th><th>{t('Remaining returnable')}</th><th>{t('Return quantity')}</th><th>{t('Item condition')}</th></tr></thead><tbody>
        {sale.items.map((item,index)=>{const remaining=item.quantity-Number(item.returnedQuantity || 0);return <tr key={item.id}><td>{item.itemName}</td><td>{money(cents(item.unitPrice))}</td><td>{remaining}</td><td><input aria-label={t('Return quantity for {name}',{name:item.itemName})} type="number" min="0" max={remaining} step="1" value={lines[index].quantity} disabled={saving||remaining===0} onChange={event=>updateLine(index,{quantity:event.target.value})}/></td><td><select aria-label={t('Condition of {name}',{name:item.itemName})} value={lines[index].condition} disabled={saving||remaining===0} onChange={event=>updateLine(index,{condition:event.target.value})}>{conditions.map(condition=><option key={condition} value={condition} disabled={condition==='SELLABLE'&&!item.productId}>{t(condition)}</option>)}</select></td></tr>})}
      </tbody></table></div>
      <div className="return-fields"><label>{t('Return date')}<input type="date" value={date} min={sale.saleDate} max={today()} onChange={event=>setDate(event.target.value)} required/></label><label>{t('Refund / difference payment method')}<select value={method} onChange={event=>setMethod(event.target.value)}>{['CASH','UPI','CARD','OTHER'].map(value=><option key={value} value={value}>{t({CASH:'Cash',UPI:'UPI',CARD:'Card',OTHER:'Other'}[value])}</option>)}</select></label><label className="return-reason">{t('Return reason')}<input value={reason} minLength={3} maxLength={300} onChange={event=>setReason(event.target.value)} required/></label></div>
      <label className="exchange-toggle"><input type="checkbox" checked={exchange} onChange={event=>setExchange(event.target.checked)} disabled={saving}/>{t('Exchange for replacement items')}</label>
      {exchange&&<div className="replacement-items"><h4>{t('Replacement items')}</h4>{replacement.map((item,index)=><div className="replacement-row" key={index}><ProductPicker item={item} onChange={value=>setReplacement(replacement.map((line,i)=>i===index?value:line))}/><label>{t('Quantity')}<input type="number" min="1" max="999999" step="1" required value={item.quantity} onChange={event=>setReplacement(replacement.map((line,i)=>i===index?{...line,quantity:event.target.value}:line))}/></label><label>{t('Negotiated selling rate')}<input inputMode="decimal" pattern="[0-9]{1,10}(\.[0-9]{1,2})?" required value={item.unitPrice} onChange={event=>setReplacement(replacement.map((line,i)=>i===index?{...line,unitPrice:event.target.value}:line))}/></label><button type="button" className="remove-item-button" disabled={replacement.length===1||saving} onClick={()=>setReplacement(replacement.filter((_,i)=>i!==index))} aria-label={t('Remove item')}><X size={16}/></button></div>)}<button className="add-item-button" type="button" disabled={saving||replacement.length>=100} onClick={()=>setReplacement([...replacement,freshItem()])}><Plus size={15}/>{t('Add item')}</button></div>}
      <div className="return-totals"><span>{t('Return credit')}: <strong>{money(credit)}</strong></span>{exchange&&<span>{t('Replacement total')}: <strong>{money(total)}</strong></span>}<span>{t(difference>0n?'Collect from customer':difference<0n?'Refund to customer':'No payment difference')}: <strong>{money(difference<0n?-difference:difference)}</strong></span></div>
      <button className="save-correction-button" disabled={saving||loading||!lines.some(line=>Number(line.quantity)>0)}>{t(saving?'Saving…':'Approve return / exchange')}</button>
    </form>
    <h4>{t('Return history')}</h4>
    {loading?<p role="status">{t('Loading return history…')}</p>:history.length===0?<p className="return-help">{t('No returns recorded.')}</p>:<ul className="return-history">{history.map(value=><li key={value.id}><strong>{new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone:'Asia/Kolkata'}).format(new Date(`${value.returnDate}T00:00:00+05:30`))} · {t('Return credit')}: {money(cents(value.creditAmount))}</strong><p>{value.items.map(item=>`${item.itemName} × ${item.quantity} (${t(item.condition)})`).join(', ')}</p><p>{value.reason} · {value.recordedBy}</p>{value.replacementSaleId&&<small>{t('Replacement sale')}: {value.replacementSaleId}</small>}<small>{t('Return reference')}: {value.id}</small></li>)}</ul>}
  </section>
}
