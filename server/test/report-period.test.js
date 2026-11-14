import test from 'node:test'
import assert from 'node:assert/strict'
import { getPeriodRange } from '../src/report-period.js'

test('daily range uses the selected calendar date', () => {
  assert.deepEqual(getPeriodRange('day', { date: '2026-10-29' }), { from: '2026-10-29', to: '2026-10-29' })
})

test('weekly range includes Monday through Sunday for the selected date', () => {
  assert.deepEqual(getPeriodRange('week', { date: '2026-10-29' }), { from: '2026-10-26', to: '2026-11-01' })
  assert.deepEqual(getPeriodRange('week', { date: '2026-11-01' }), { from: '2026-10-26', to: '2026-11-01' })
})

test('monthly range uses the selected month and handles leap February', () => {
  assert.deepEqual(getPeriodRange('month', { month: '2024-02' }), { from: '2024-02-01', to: '2024-02-29', month: '2024-02' })
  assert.deepEqual(getPeriodRange('month', { month: '2026-10' }), { from: '2026-10-01', to: '2026-10-31', month: '2026-10' })
})

test('custom range rejects invalid dates and reversed bounds', () => {
  assert.deepEqual(getPeriodRange('custom', { from: '2026-10-01', to: '2026-10-03' }), { from: '2026-10-01', to: '2026-10-03' })
  assert.throws(() => getPeriodRange('custom', { from: '2026-02-30', to: '2026-03-01' }), /valid custom date range/)
  assert.throws(() => getPeriodRange('custom', { from: '2026-10-04', to: '2026-10-03' }), /valid custom date range/)
})

test('a current business date supplies implicit today and current month boundaries', () => {
  assert.deepEqual(getPeriodRange('day', {}, '2026-10-29'), { from: '2026-10-29', to: '2026-10-29' })
  assert.deepEqual(getPeriodRange('month', {}, '2026-10-29'), { from: '2026-10-01', to: '2026-10-31', month: '2026-10' })
})
