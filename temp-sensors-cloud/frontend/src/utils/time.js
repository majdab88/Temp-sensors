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
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// Relative for anything within the last day, absolute date+time for older —
// so "2 min ago" stays legible but last week's event shows its real date.
export function smartTime(input) {
  const d = input instanceof Date ? input : new Date(input)
  const s = Math.floor((Date.now() - d.getTime()) / 1000)
  if (s < 24 * 3600) return timeAgo(d)
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
