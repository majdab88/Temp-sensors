# Mobile App — Dashboard Feature Parity Checklist

> **Status (2026-11-27, branch `claude/app-redesign`):** the app was rebuilt in
> the agreed "Frost" design (see `src/theme.ts`) and every item below is
> implemented except those marked **[—]** (out of scope by agreement).
> Verified: `tsc --noEmit` clean; Android Metro/Hermes bundle builds; every
> screen exercised in the Expo web build against mocked API data (owner and
> superadmin roles, "View as"). **Not yet verified on a phone or against the
> live server:** BLE hub setup, push registration, saving CSV/PDF exports,
> and live Socket.IO updates. Needs an EAS build to test.

Every feature of the web dashboard (`temp-sensors-cloud/frontend/src`) and what
the app must have to match it. Both talk to the **same backend API and Socket.IO
events**, so the backend side of every item already exists; each line names the
endpoint and the web file to mirror.

Inventory taken 2026-11-27 from `frontend/src` at main `90f2868`.

**Role legend** — *all*: every signed-in user · *editor*: org permission
editor/admin, owners, and superadmin (web: `permissionLevel !== 'viewer'`) ·
*org-admin*: owner, admin permission, superadmin · *SA*: superadmin only.

A superadmin who is not viewing an org ("View as") sees only the admin screens
(Orgs, Users, Firmware, Audit log, Account); sensor screens need an org context.

---

## Session & app-wide

- [x] **Login** with email *or* username (username = superadmin) — `POST /auth/login` sends `{email}` or `{username}`. (`Login.jsx`)
- [x] **Silent token refresh** on 401 — `POST /auth/refresh`; a failed refresh signs out.
- [x] **Socket.IO live connection** with the token read fresh on every (re)connect; reconnect after a refused handshake once a REST call renewed the token. (`services/socket.js`)
- [x] **Hub rooms** — `join`/`leave` each hub MAC; re-join on `connect` (the server replays cached `hubStatus` on join).
- [x] **Superadmin "View as org"** — `X-Org-Id` header; a visible "Viewing: <org> ✕" chip to stop. (`Layout.jsx`, `Organizations.jsx`)
- [x] **Role-gated navigation** — Devices + Setup hidden for viewers; Orgs + Audit log for org-admins; Users + Firmware for SA. (`Layout.jsx`)
- [x] **Signed-in identity** shown (email/username · role) and **Logout**.
- [x] **Day-first dates** (`dd/mm/yyyy`, 24 h, `en-GB`) everywhere; relative "x min ago" within a day, absolute after. (`utils/time.js`)
- [x] **Confirm every destructive action** with a native confirm — never proceed silently.
- [x] **Toasts** for success / failure of actions. (`ToastContext.jsx`)
- [x] **Push notifications** (app-only, keep): register the Expo token on login (`POST /push/register`), unregister on logout (`DELETE /push/register`).

## Dashboard (`Dashboard.jsx`, `SensorCard.jsx`) — *all*

- [x] **Alarm hero** — worst active breach (largest distance past its limit, against the *current* reading): "<sensor> is X° above/below its limit", minutes active, *View sensor*, *Acknowledge* (editor) or "✓ Acknowledged · who", *Alert rules*, "+ N more: …".
- [x] **All-clear strip** when no alarm: "All sensors within limits · n/N online" (online = reading < 15 min old).
- [x] **Sensor list** header: "N paired · n online · live", *+ Pair sensor* (editor → Devices).
- [x] **Empty state** — "No sensors yet".
- [x] **Active alarms list** — breaching value vs limit, "· now X °C" when the live value differs ≥ 0.1, *Details*, *Acknowledge* / "✓ Acked · who". `GET /alerts/active`, `POST /excursions/:id/ack`.
- [x] **Recent alerts** — last 8 transitions: "crossed its max/min limit — X °C" / "back in range". `GET /alerts/events?limit=8`.
- [x] Live updates: `sensorData` (reading, `probe_error`, sparkline append, live detection), `alert` (add/clear breach, prepend event), `liveState`.

### Sensor card
- [x] Hub name eyebrow; sensor name; MAC.
- [x] **Status chip** — ALARM › PROBE ERROR › OFFLINE (> 60 min) › STALE (15–60 min) › NO DATA › OK.
- [x] **Temperature** large (alarm-coloured when breached), `--` when none; **RH %** when present (not on NTC, `hum = -999`/null).
- [x] **Limit note** from the enabled rule ("max 8° · min 2°").
- [x] **24 h sparkline** (≤ 48 points, min 4 °C span; alarm-coloured when breached). `GET /sensors/:id/readings?from=`.
- [x] Meta: age, RSSI dBm, firmware `v1.1.x` (absent on pre-1.0), battery.
- [x] **Battery** — full ≥ 40 % / half 22–40 % / low < 22 %; hidden when 255/null; shows **`bat_load_mv` under load and `bat_mv` at rest** in volts. `GET /sensors/:id/readings/latest` (has both voltages) + `sensorData`.
- [x] **Battery type** Li / Alk — editor toggles (`PUT /sensors/:id/battery-type`, response's `battery` updates the %); read-only label for viewers.
- [x] **Rename** (editor) — `PUT /sensors/:id`.
- [x] **Delete** (editor, confirm) — `DELETE /sensors/:id`.
- [x] **Temperature alert rule editor** (editor) — enabled toggle, max, min, recovery margin, channels Dashboard / Push; validation (a limit set, min < max, margin ≥ 0, ≥ 1 channel); *Remove* with confirm. `GET/PUT/DELETE /alerts/rules/:id`. **No WhatsApp** (not built; PR #77 closed).
- [x] **Live mode** (editor) — request (`POST /sensors/:id/live`) with the queued note ("N readings, one every Ns… starts on next wake, up to ~M min, or press its button"); stop/cancel (`DELETE /sensors/:id/live`).
- [x] Live chips — **live Ns** countdown (from `live_until`, or readings < 150 s apart within 3 intervals' grace); **waking ~Xm** while requested (bounded by interval + 2 min, cleared by a reading that arrived after the request).
- [x] **Sensor configuration** (SA) — interval 5–60 min, series resistor, Steinhart-Hart A/B/C (scientific notation), calibration-change confirm, "queued — applies within ~N min" / "no change", pending banner, recent-changes history. `GET/PUT /sensor-config/:id`.
- [x] Tap → sensor history.

## History (`History.jsx`, `ReadingChart.jsx`) — *all*

- [x] **Sensor picker** (in the app: the sensor's own detail screen).
- [x] **Range presets** 24 h / 7 d / 30 d and a **custom from → to** date range, day-first.
- [x] **Chart** — temperature (and humidity when present), threshold bands + dashed limit lines from the enabled rule, minimum 25 °C axis window snapped to 5 °C. `GET /sensors/:id/readings?from&to&limit=500`.
- [x] **Stats** — Min, Max, Avg, **MKT** (ΔH/R = 10000 K), **In range %** (when limits exist).
- [x] **Readings table** — newest first: #, time (dd/mm/yyyy HH:MM:SS), temp (2 dp), RH, RSSI, battery.
- [x] **PDF report** (web: print) — app: generate a PDF and save it to the phone (Android: a folder chosen once, Downloads offered; iOS: share sheet → Save to Files).

## Alert rules (`AlertRules.jsx`) — *all*, edits *editor*

- [x] Header "N rules · n firing".
- [x] **Every sensor's rule** — condition ("above 8 °C or below 2 °C"), channels, status FIRING / ARMED / PAUSED, "No rule".
- [x] Per-row **Pause / Arm**, **Edit**, **Remove** (confirm), **Add rule**.
- [x] **New / edit rule form** with sensor picker (default channels Dashboard + Push).
- [x] **Device health alerts** (org-wide) — Sensor offline after N min (5–1440), Hub offline grace N min (1–1440), Low battery, Unacknowledged-alarm re-notify every N min. `GET/PUT /health/settings`. Read-only for viewers.

## Reports — excursion log (`Reports.jsx`, `ExcursionDetail.jsx`) — *all*, ack *editor*

- [x] **Summary** — Excursions, Ongoing, Unacknowledged.
- [x] **Filters** — sensor, status (All / Ongoing / Unacknowledged), range 7 d / 30 d / 90 d / All. `GET /excursions?sensor_id&active&unacked&from&limit=500`.
- [x] **List** — sensor + hub, Over/Under, started, duration or "ongoing", peak, limit, ack status / *Acknowledge*.
- [x] **Export CSV** — `GET /excursions/export.csv` (same filters) → saved to the phone.
- [x] **Print / PDF** of the log → generated PDF saved to the phone.
- [x] **Excursion detail** — peak / limit / duration, started / ended / ack (who, when), *Acknowledge*, breach chart (shaded window, limit line, peak marker). `GET /excursions/:id`.
- [x] Detail **Export readings CSV** (window ± 30 min) — `GET /sensors/:id/readings/export.csv?from&to`.
- [x] Detail **Print / PDF**.

## Devices (`Devices.jsx`) — *editor* (hidden for viewers)

- [x] Hub list: name ("Unnamed Hub" only if truly unnamed — server auto-names `TempHub-XXXXXX`), MAC, registered (day-first), IP, firmware (live `hubStatus.fw` over stored), boot image state note.
- [x] **Online / Offline / Unknown** — live via `hubStatus`, seeded from `GET /devices` `online`.
- [x] **Rename** — `PUT /devices/:id`.
- [x] **Remove** (confirm: deletes the hub, its sensors and readings) — `DELETE /devices/:id`.
- [x] **Add sensor** (hub must be online; one hub at a time) — `POST /pairing/enable`, 2-minute countdown, cancel; `pairingModeStatus` off ends it.
- [x] **Live pairing requests** (`pairingRequest`, field `sensor_mac`) shown as `TempSens-XXXXXX` + MAC, **Approve / Reject**; approving ends pairing mode.
- [x] **"Sensor already paired" warning** — if the MAC is active on a *different* hub (`GET /sensors`), confirm "…will move it and its reading history to this hub" before approving.
- [x] Empty state.

## Setup — add a hub (`Provision.jsx`) — *editor*

The app keeps this deliberately non-technical (agreed 2026-11-27): the person
setting up a hub sees "find hub → choose WiFi → password → progress → done",
never a MAC, broker or log. Same backend calls as the web page.

- [x] BLE scan for `TempHub-*` → connect → MAC read from `PROV_INFO` behind the scenes.
- [x] **Register** — `POST /devices/register` returns `api_key` + `mqtt_user`; broker from `GET /provision/config`. Not shown to the user.
- [x] WiFi network scan (`PROV_NETWORKS`) with signal bars + lock, "my network isn't listed", password (skipped for open networks), show/hide.
- [x] Write WiFi + cloud credentials; follow `PROV_STATUS` as three progress steps; errors worded as what to do; success screen.
- [—] Manual MAC entry, hub name field, broker details, activity log — left out of the app on purpose (hub can be renamed on the Hubs tab).

## Organizations (`Organizations.jsx`) — *org-admin*; "View as" *SA*

- [x] Org list: name, owner, hubs · members, created. `GET /organizations`.
- [x] **View as** (SA).
- [x] Expand → **Members** (`GET /organizations/:id/members`): role badge, permission level Viewer / Editor / Admin (change: `PUT …/members/:uid/permissions`), **Remove** (confirm).
- [x] **Invite member** — email, password (new users only), permission level. `POST …/members`.
- [x] **Devices & sensors** of the org (`GET /organizations/:id/devices`) — hub rename, sensors with active/inactive and paired date.

## Users (`Users.jsx`, `EditUserModal.jsx`) — *SA*

- [x] List: email/username, role, joined, orgs.
- [x] **New owner** — email, password ≥ 10, optional org name. `POST /users`.
- [x] **Edit** — email, username, role owner/member, optional new password. `PUT /users/:id`.
- [x] **Delete** (confirm). `DELETE /users/:id`.

## Firmware (`Firmware.jsx`, `utils/otaOutcome.js`) — *SA*

- [—] **Upload** — kind hub/sensor, `.bin` file, version, notes, signature. **Out of scope (agreed 2026-11-27):** stays on the web dashboard / `publish.sh`; the app says so on the Firmware screen.
- [x] Image list — version, kind, size, SHA-256, notes, uploaded when/by; **Delete** (confirm).
- [x] **Hub rows** — current version, Install / Retry / progress (`otaStatus`), busy-elsewhere, 20-min stale rule, outcome note. `POST /firmware/:id/stage {hub_mac}`.
- [x] **Sensor rows** — Send / Retry, "staged · press the button", progress (`sensorOtaStatus`), cancel (`DELETE /firmware/stage/:sensorId`), installed, rollback detection, outcome note with what to do.
- [x] Live version pickup from `sensorData.fw`; reload on `installed` / `confirmed`.

## Audit log (`AuditLog.jsx`) — *org-admin*

- [x] Entries: time, action label, user, target `type #id`, details. `GET /audit-log?limit&offset&action` → `{rows, total}`.
- [x] **Action filter** and **pagination** (30 per page).

## Account (`Account.jsx`) — *all*

- [x] Profile: username, email, role, joined; **edit** username/email. `GET/PUT /account`.
- [x] **Memberships** — org, role, permission level ("All permissions" for owners).
- [x] **Change password** (≥ 10, confirm match), keeping the session on the returned tokens. `PUT /account/password`.

---

## Out of scope (agreed or by design)

- **WhatsApp** channel — not built (PR #77 closed 2026-11-27); the app does not offer it.
- **Pairing history** (`pages/Pairing.jsx`, pending/approved/rejected tabs) — not routed in the web dashboard; dead code there.
- **Middle-click / new-tab** behaviour of cards — browser-only.
- **Firmware upload** from the phone — agreed 2026-11-27; upload from the web dashboard or `tools/firmware-signing/publish.sh`.

## Already handled by the shared backend

- Hub auto-name default — `routes/devices.js` (register).
- Hub delete cascade — `DELETE /api/devices/:id`, editor-level, org-scoped.
- Sensor migration on re-pair — `routes/pairing.js` (`resolveRequest`) consolidates the sensor's rows under the new hub; the app only warns first.
- Battery % per chemistry — `backend/src/battery.js`.
