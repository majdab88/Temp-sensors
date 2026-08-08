// Compact "x min ago" relative time.
export function timeAgo(input) {
  const d = input instanceof Date ? input : new Date(input)
  const s = Math.floor((Date.now() - d.getTime()) / 1000)
  if (s < 45) return 'just now'
  if (s < 90) return '1 min ago'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  const days = Math.floor(h / 24)
  if (days < 7) return `${days} d ago`
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

// Absolute date+time, day-first (dd/mm/yyyy, HH:MM:SS, 24 h). Locale is forced
// to en-GB so every date the app renders is day-first regardless of the
// viewer's browser locale. Returns '' for empty/invalid input.
export function formatDateTime(input) {
  if (!input) return ''
  const d = input instanceof Date ? input : new Date(input)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}

// Relative for anything within the last day, absolute date+time for older —
// so "2 min ago" stays legible but last week's event shows its real date.
export function smartTime(input) {
  const d = input instanceof Date ? input : new Date(input)
  const s = Math.floor((Date.now() - d.getTime()) / 1000)
  if (s < 24 * 3600) return timeAgo(d)
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
