export const validDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value && value.slice(0, 4) !== '0000'
}

export const validMonth = value => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value || '')) return false
  return value.slice(0, 4) !== '0000'
}

function addDays(value, amount) {
  const date = new Date(`${value}T12:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

export function getPeriodRange(period, selection = {}, today) {
  if (period === 'custom') {
    if (!validDate(selection.from) || !validDate(selection.to) || selection.from > selection.to) throw new Error('Choose a valid custom date range.')
    return { from: selection.from, to: selection.to }
  }
  if (period === 'day' || period === 'week') {
    const selectedDate = selection.date || today
    if (!validDate(selectedDate)) throw new Error('Choose a valid date.')
    if (period === 'day') return { from: selectedDate, to: selectedDate }
    const weekday = new Date(`${selectedDate}T12:00:00.000Z`).getUTCDay()
    const monday = addDays(selectedDate, -((weekday + 6) % 7))
    return { from: monday, to: addDays(monday, 6) }
  }
  if (period === 'month') {
    const selectedMonth = selection.month || (validDate(today) ? today.slice(0, 7) : '')
    if (!validMonth(selectedMonth)) throw new Error('Choose a valid month and year.')
    const first = `${selectedMonth}-01`
    const nextMonth = `${addDays(first, 32).slice(0, 7)}-01`
    return { from: first, to: addDays(nextMonth, -1), month: selectedMonth }
  }
  throw new Error('Choose daily, weekly, monthly or custom report.')
}
