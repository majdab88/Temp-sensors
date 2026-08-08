# Mobile App — Dashboard Feature Parity Checklist

When the mobile app is rebuilt / restyled to match the **web dashboard** design
(Archivo + IBM Plex Mono, vermilion `#E63A11` for alarms only, flat gray cards —
see cloud PR #82), **make sure it includes the features below**. These were added
to the web dashboard incrementally after the app's original build, so they're
easy to miss when reworking the app.

The mobile app and the dashboard share the **same backend API**, so the backend
side of each feature already works — the app mostly needs the matching UI.
Each item points at the dashboard implementation to mirror.

---

## Devices (`src/screens/DevicesScreen.tsx`, `DeviceRow`, `PairingCard`, `PairingScreen`)

- [ ] **Hub online / offline / unknown status** — live via socket `hubStatus`. (Web: `pages/Devices.jsx`.)
- [ ] **Hub rename** — `PUT /api/devices/:id`.
- [ ] **Hub delete** — `DELETE /api/devices/:id` (cascades the hub's sensors + readings). Must confirm first (native `Alert`), not delete silently.
- [ ] **Auto-named hubs** — new hubs default to `TempHub-XXXXXX` (last 3 MAC octets) server-side; show that, fall back to "Unnamed Hub" only if truly unnamed.
- [ ] **"Add Sensor" pairing flow** — enable pairing mode with a 2-minute countdown + live pairing-request list with **Approve / Reject**.
- [ ] **"Sensor already paired" warning** — approving a request for a sensor that's active on a *different* hub must confirm ("… will move it and its reading history to this hub. Continue?") before approving, since the backend migrates it. Cross-reference `GET /api/sensors`. (Web: `pages/Devices.jsx` `handleApprove`.)

## Sensor detail / history (`src/screens/SensorDetailScreen.tsx`, `ReadingChart`)

- [ ] **Day-first dates (`dd/mm/yyyy`, 24 h)** — everywhere a date/time is shown.
- [ ] **Range presets + custom range** — 24 h / 7 d / 30 d plus a custom from→to range with date pickers.
- [ ] **Report/export** — the web has a PDF report (`window.print()`); decide the app equivalent (share/export) if wanted.

## App-wide

- [ ] **All dates render day-first (`dd/mm/yyyy`)** — the web forces the `en-GB` locale so dates are day-first regardless of device locale. Do the same in the app's date formatting util.
- [ ] **Confirm before every destructive action** — hub delete, sensor delete/move, etc. The web uses a design-native confirm dialog (`toast.confirm`); the app should use a native `Alert.alert` confirm (never proceed silently).

---

## Already handled by the shared backend (no app-side backend work)

- **Hub auto-name default** — `temp-sensors-cloud/backend/src/routes/devices.js` (register).
- **Hub delete** — `DELETE /api/devices/:id`, editor-level, org-scoped, cascades.
- **Sensor migration / consolidation on re-pair** — `routes/pairing.js` (`resolveRequest`): on approval, consolidates all rows for the sensor's MAC in the org down to one under the new hub, keeping the row with the most reading history. Works across any number of hubs in the same org. The app just needs to surface the "already paired → will move" warning before calling approve.
