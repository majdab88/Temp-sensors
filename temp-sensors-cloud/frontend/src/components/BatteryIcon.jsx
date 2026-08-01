import React from 'react'

/**
 * Coarse battery indicator — full / half / low — derived from the L91 pack %
 * (which the sensor computes from true pack voltage). No number shown; the exact
 * % lives in the hub /logs page. 255 / null = unknown → nothing rendered.
 *
 *   Full  >= 40 %  (>= ~2.8 V)
 *   Half  22-40 %  (~2.5-2.8 V)
 *   Low   <  22 %  (< ~2.5 V)
 */
export default function BatteryIcon({ level }) {
  if (level == null || level === 255) return null

  const lvl   = level < 22 ? 'low' : level < 40 ? 'half' : 'full'
  const color = lvl === 'low' ? 'var(--red)' : lvl === 'half' ? 'var(--yellow)' : 'var(--green)'
  const fillW = lvl === 'low' ? 4 : lvl === 'half' ? 8.5 : 15
  const title = lvl === 'low' ? 'Battery low' : lvl === 'half' ? 'Battery ~half' : 'Battery full'

  return (
    <span className="sensor-meta-item" title={title} style={{ display: 'inline-flex', alignItems: 'center' }}>
      <svg width="22" height="12" viewBox="0 0 22 12" role="img" aria-label={title}>
        <rect x="0.75" y="0.75" width="18" height="10.5" rx="2" fill="none" stroke="var(--text-3)" strokeWidth="1" />
        <rect x="19.5" y="3.5" width="2" height="5" rx="1" fill="var(--text-3)" />
        <rect x="2.25" y="2.25" width={fillW} height="7.5" rx="1" fill={color} />
      </svg>
    </span>
  )
}
