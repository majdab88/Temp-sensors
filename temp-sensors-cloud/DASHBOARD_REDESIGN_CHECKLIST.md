# Dashboard Redesign Checklist — Don't Drop These Features

When the web dashboard is rebuilt/restyled to fully match the design system
(Archivo + IBM Plex Mono, vermilion `#E63A11` for alarms only, flat gray cards —
see PR #82), **carry over every feature below**. These were added incrementally
after the original build, so a from-scratch UI rewrite can easily lose them.

Each item notes where it lives today so the behavior can be re-implemented.

---

## Devices page (`frontend/src/pages/Devices.jsx`)

- [ ] **Hub online / offline / unknown status** — live via socket `hubStatus`; shows IP when known.
- [ ] **Hub rename** — inline edit → `PUT /api/devices/:id`.
- [ ] **Hub delete ("Remove" button)** — `DELETE /api/devices/:id`; cascades the hub's sensors + readings. Must use the in-app confirm dialog (see below), not `window.confirm`.
- [ ] **Auto-named hubs** — new hubs default to `TempHub-XXXXXX` (last 3 MAC octets); UI falls back to "Unnamed Hub" only if truly unnamed. (Backend default: `routes/devices.js` register.)
- [ ] **"+ Add Sensor" pairing flow** — enables pairing mode with a 2-minute countdown, live pairing-request panel with **Approve / Reject**.
- [ ] **"Sensor already paired" warning** — approving a request for a sensor that's active on a *different* hub pops a confirm ("… will move it and its reading history to this hub. Continue?") before migrating. Cross-references `GET /api/sensors`.

## History page (`frontend/src/pages/History.jsx`)

- [ ] **Day-first date fields (`dd/mm/yyyy`)** — custom-range inputs are masked text fields (auto-insert slashes), NOT native `<input type=date>` (Chrome can't force its display format). Keep the `dd/mm/yyyy` display.
- [ ] **Calendar button (📅)** — opens the native picker via `input.showPicker()` (falls back to `.click()`); a hidden native date input is the calendar source. Keep both the typed field AND the calendar.
- [ ] **Range presets + custom range** — 24 h / 7 d / 30 d buttons plus the custom from→to range.
- [ ] **Controls row alignment** — the row is bottom-aligned (`align-items: flex-end`) so the labeled Sensor dropdown lines up with the label-less buttons/date fields.
- [ ] **PDF report** — `window.print()` with a print-only report header (`.print-only` blocks).

## App-wide

- [ ] **All dates render day-first (`dd/mm/yyyy`, 24 h)** — every date is formatted with the `en-GB` locale so it's day-first regardless of the viewer's browser locale. See `utils/time.js` (`formatDateTime`, `smartTime`, `timeAgo`) and the `toLocaleString('en-GB', …)` calls across pages (ReadingChart table, Reports, ExcursionDetail, AuditLog, Users, Organizations, Account, Devices, PairingPanel).
- [ ] **Design-native confirm dialog for ALL destructive actions** — use `toast.confirm({ title, message, danger, confirmLabel })` from `context/ToastContext.jsx`. Never use the browser's `window.confirm` / `alert`.

---

## Backend the dashboard depends on (keep even if the UI is rewritten)

- **Hub auto-name default** — `routes/devices.js` (register): defaults a new hub's name to `TempHub-XXXXXX`; preserves a custom name on re-provision.
- **Hub delete** — `routes/devices.js`: `DELETE /api/devices/:id`, editor-level, org-scoped, cascades.
- **Sensor migration / consolidation on re-pair** — `routes/pairing.js` (`resolveRequest`): on approval, consolidates all rows for the sensor's MAC in the org down to one under the new hub, keeping the row with the most reading history. Works across any number of hubs within the same org.
