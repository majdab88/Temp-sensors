// CSV and PDF exports. The web dashboard downloads a CSV and prints the page;
// on a phone both become a file handed to the share sheet (mail, Drive,
// WhatsApp, print…). The web build of the app downloads / opens print instead.
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
import { formatDateTime, formatDateTimeShort } from '../utils/time';

const safe = (name: string) => name.replace(/[^\w.-]+/g, '_');

export async function shareCsv(text: string, filename: string): Promise<void> {
  const name = safe(filename);
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
    return;
  }
  const uri = `${FileSystem.cacheDirectory}${name}`;
  await FileSystem.writeAsStringAsync(uri, text, { encoding: FileSystem.EncodingType.UTF8 });
  await Sharing.shareAsync(uri, { mimeType: 'text/csv', dialogTitle: name, UTI: 'public.comma-separated-values-text' });
}

export async function sharePdf(html: string, filename: string): Promise<void> {
  if (Platform.OS === 'web') { await Print.printAsync({ html }); return; }
  const { uri } = await Print.printToFileAsync({ html });
  const target = `${FileSystem.cacheDirectory}${safe(filename)}`;
  await FileSystem.deleteAsync(target, { idempotent: true });
  await FileSystem.moveAsync({ from: uri, to: target });
  await Sharing.shareAsync(target, { mimeType: 'application/pdf', dialogTitle: filename, UTI: 'com.adobe.pdf' });
}

// ── Report HTML ──────────────────────────────────────────────────────────────
export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** A printable page in the app's Frost style. `body` is trusted HTML built with esc(). */
export function reportHtml(title: string, subtitle: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { margin: 16mm; }
  body { font-family: -apple-system, Roboto, 'Segoe UI', Helvetica, Arial, sans-serif; color: #0E1A24; font-size: 11px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: #5B6B77; margin-bottom: 14px; }
  .stats { display: flex; gap: 8px; margin: 12px 0; }
  .stat { flex: 1; background: #F2F6F8; border-radius: 8px; padding: 8px 10px; }
  .stat b { display: block; font-family: Menlo, Consolas, monospace; font-size: 15px; margin-top: 2px; }
  .alarm { color: #D7263D; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th { text-align: left; color: #5B6B77; font-weight: 600; border-bottom: 1px solid #C3D1D9; padding: 5px 4px; }
  td { border-bottom: 1px solid #E7EEF2; padding: 4px; font-family: Menlo, Consolas, monospace; }
  .foot { color: #8A99A4; margin-top: 16px; font-size: 10px; }
</style></head><body>
<h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div>
${body}
<div class="foot">Generated ${esc(formatDateTime(new Date()))} · Temp Sensors</div>
</body></html>`;
}

export function statsHtml(items: { label: string; value: string; alarm?: boolean }[]): string {
  return `<div class="stats">${items.map((s) =>
    `<div class="stat">${esc(s.label)}<b class="${s.alarm ? 'alarm' : ''}">${esc(s.value)}</b></div>`).join('')}</div>`;
}

export function tableHtml(head: string[], rows: (string | number | null | undefined)[][]): string {
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

/** Inline SVG line chart for a report: temperature over time, limits dashed. */
export function chartSvg(points: { t: number; v: number }[], high: number | null, low: number | null): string {
  if (points.length < 2) return '';
  const W = 700, H = 220, pl = 40, pr = 10, pt = 10, pb = 22;
  const vals = points.map((p) => p.v).concat([high, low].filter((x): x is number => x != null));
  const lo = Math.min(...vals) - 1, hi = Math.max(...vals) + 1;
  const t0 = points[0].t, t1 = points[points.length - 1].t;
  const x = (t: number) => pl + ((t - t0) / (t1 - t0 || 1)) * (W - pl - pr);
  const y = (v: number) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  const line = points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const lim = (v: number | null, c: string) => v == null ? '' :
    `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="${c}" stroke-dasharray="5,4"/><text x="${W - pr}" y="${y(v) - 3}" font-size="9" text-anchor="end" fill="${c}">${v}°</text>`;
  const ticks = [lo, (lo + hi) / 2, hi].map((v) =>
    `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="#E7EEF2"/><text x="${pl - 4}" y="${y(v) + 3}" font-size="9" text-anchor="end" fill="#8A99A4">${v.toFixed(1)}°</text>`).join('');
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${ticks}${lim(high, '#D7263D')}${lim(low, '#1E5D77')}
<polyline points="${line}" fill="none" stroke="#2F7F9F" stroke-width="1.6"/>
<text x="${pl}" y="${H - 6}" font-size="9" fill="#8A99A4">${esc(formatDateTimeShort(t0))}</text>
<text x="${W - pr}" y="${H - 6}" font-size="9" text-anchor="end" fill="#8A99A4">${esc(formatDateTimeShort(t1))}</text></svg>`;
}
