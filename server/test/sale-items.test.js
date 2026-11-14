import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateSaleTotal, saleItemsSchema, unitPriceToCents } from '../src/sale-items.js'

test('sale item totals use exact integer cents', () => {
  const items = saleItemsSchema.parse([
    { itemName: 'Kurti', quantity: '2', unitPrice: '650.00' },
    { itemName: 'Saree', quantity: '1', unitPrice: '1500' },
    { itemName: 'Leggings', quantity: '3', unitPrice: '250.00' },
  ])
  assert.equal(calculateSaleTotal(items), '3550.00')
  assert.equal(unitPriceToCents('0.09'), 9n)
  assert.equal(calculateSaleTotal([{ itemName: 'Small item', quantity: 3, unitPrice: '0.10' }]), '0.30')
})

test('sale item validation rejects empty names, invalid quantity and negative or excessive price', () => {
  for (const item of [
    { itemName: '   ', quantity: '1', unitPrice: '1.00' },
    { itemName: 'Item', quantity: '0', unitPrice: '1.00' },
    { itemName: 'Item', quantity: '1.2', unitPrice: '1.00' },
    { itemName: 'Item', quantity: '1', unitPrice: '-1.00' },
    { itemName: 'Item', quantity: '1', unitPrice: '10000000000.00' },
  ]) assert.equal(saleItemsSchema.safeParse([item]).success, false)
  assert.equal(saleItemsSchema.safeParse([]).success, false)
})

test('sale totals reject zero and values above the parent numeric capacity', () => {
  assert.throws(() => calculateSaleTotal([{ itemName: 'Free', quantity: 1, unitPrice: '0' }]), /greater than/)
  assert.throws(() => calculateSaleTotal([{ itemName: 'Large', quantity: 999999, unitPrice: '9999999999.99' }]), /maximum/)
})
