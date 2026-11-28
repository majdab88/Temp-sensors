// CSV and PDF exports.
//
// CSV on Android is saved like a browser download: the first export asks once
// for a folder (Downloads is offered) and every later one writes straight into
// it. A PDF on Android opens in the phone's PDF viewer, the way other apps hand
// one over — the viewer offers download, print and share itself. iOS has no
// Downloads folder, so both go to the share sheet, whose "Save to Files" is the
// equivalent. The web build downloads the CSV and opens print for the PDF.
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
import { getItem, setItem, deleteItem } from './storage';
import { formatDateTime, formatDateTimeShort } from '../utils/time';

const SAF = FileSystem.StorageAccessFramework;
const DIR_KEY = 'export_dir_uri';
const safe = (name: string) => name.replace(/[^\w.-]+/g, '_');

/** "Download" from content://…/tree/primary%3ADownload */
function folderName(dirUri: string): string {
  const last = decodeURIComponent(dirUri.split('/').pop() || '');
  return last.split(':').pop() || 'the chosen folder';
}

/**
 * Write a file into the remembered folder, asking for one the first time (or
 * again if access was revoked). Returns the folder's name, or null when the
 * person backed out of the folder picker.
 */
async function saveAndroid(filename: string, mime: string, data: string, encoding: FileSystem.EncodingType): Promise<string | null> {
  // Android adds the extension that matches the MIME type itself.
  const base = safe(filename).replace(/\.(pdf|csv)$/i, '');
  const write = async (dir: string) => {
    const uri = await SAF.createFileAsync(dir, base, mime);
    await FileSystem.writeAsStringAsync(uri, data, { encoding });
    return folderName(dir);
  };
  const remembered = await getItem(DIR_KEY);
  if (remembered) {
    try { return await write(remembered); } catch { await deleteItem(DIR_KEY); }
  }
  const perm = await SAF.requestDirectoryPermissionsAsync(SAF.getUriForDirectoryInRoot('Download'));
  if (!perm.granted) return null;
  await setItem(DIR_KEY, perm.directoryUri);
  return write(perm.directoryUri);
}

/** Save a CSV. Resolves to a "Saved to …" message, or null if nothing to say. */
export async function saveCsv(text: string, filename: string): Promise<string | null> {
  const name = safe(filename);
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
    return null;
  }
  if (Platform.OS === 'android') {
    const where = await saveAndroid(name, 'text/csv', text, FileSystem.EncodingType.UTF8);
    return where ? `Saved ${name} to ${where}` : null;
  }
  const uri = `${FileSystem.cacheDirectory}${name}`;
  await FileSystem.writeAsStringAsync(uri, text, { encoding: FileSystem.EncodingType.UTF8 });
  await Sharing.shareAsync(uri, { mimeType: 'text/csv', UTI: 'public.comma-separated-values-text' });
  return null;
}

/** Render HTML to a PDF and open it (Android) or share it (iOS). Resolves like saveCsv. */
export async function savePdf(html: string, filename: string): Promise<string | null> {
  if (Platform.OS === 'web') { await Print.printAsync({ html }); return null; }
  const { uri } = await Print.printToFileAsync({ html });
  // printToFileAsync names the file with a UUID; the viewer shows the name.
  const target = `${FileSystem.cacheDirectory}${safe(filename)}`;
  await FileSystem.deleteAsync(target, { idempotent: true });
  await FileSystem.moveAsync({ from: uri, to: target });
  if (Platform.OS === 'android') {
    try {
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: await FileSystem.getContentUriAsync(target),
        type: 'application/pdf',
        flags: 1, // FLAG_GRANT_READ_URI_PERMISSION: the viewer reads our cache file
      });
      return null;
    } catch {
      // No app on the phone can view a PDF: fall through to the share sheet.
    }
  }
  await Sharing.shareAsync(target, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' });
  return null;
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
