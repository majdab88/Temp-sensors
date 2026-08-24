import { useEffect, useRef, useState } from 'react'
import api from '../services/api'
import socket from '../services/socket'

/**
 * Firmware registry — superadmin only.
 *
 * Upload a signed image, then stage it on one hub at a time. Signing happens
 * offline with tools/firmware-signing/sign.js; the private key never reaches
 * this server. The SHA-256 is computed by the backend from the uploaded bytes,
 * so it is never something anyone can paste incorrectly.
 */
// Longer than the firmware's worst-case app-level rollback (3 boot attempts at
// 5 minutes each), so a hub that is genuinely mid-recovery is not mistaken for
// an abandoned update.
const OTA_STALE_MS = 20 * 60 * 1000

export default function Firmware() {
  const [images, setImages] = useState([])
  const [hubs, setHubs] = useState([])
  const [sensors, setSensors] = useState([])
  const [otaState, setOtaState] = useState({})   // hub_mac -> latest ota/status
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const hubMacsRef = useRef([])

  const [file, setFile] = useState(null)
  const [version, setVersion] = useState('')
  const [signature, setSignature] = useState('')
  const [notes, setNotes] = useState('')

  async function load() {
    try {
      const [fwRes, devRes, senRes] = await Promise.all([
        api.get('/firmware'),
        api.get('/devices'),
        api.get('/sensors').catch(() => ({ data: [] })),
      ])
      setImages(fwRes.data)
      setHubs(devRes.data)
      setSensors(senRes.data)
      hubMacsRef.current = devRes.data.map((d) => d.mac)

      // Seed from stored state so a refresh mid-update still shows progress.
      const seeded = {}
      for (const d of devRes.data) {
        if (d.ota_state) {
          seeded[d.mac] = { state: d.ota_state, version: d.ota_version, pct: d.ota_pct,
                             error: d.ota_error, updatedAt: d.ota_updated_at }
        }
      }
      setOtaState(seeded)
      devRes.data.forEach((d) => socket.emit('join', d.mac))
    } catch {
      setError('Failed to load firmware registry')
    }
  }

  useEffect(() => {
    // The shared socket is autoConnect:false — a page reached without passing
    // through Dashboard/Devices would otherwise never receive OTA progress.
    if (!socket.connected) socket.connect()

    load()

    function onSensorOtaStatus(data) {
      setSensors((prev) => prev.map((x) =>
        x.mac === data.sensor_mac
          ? { ...x, ota_state: data.state, ota_pct: data.pct, ota_error: data.error }
          : x
      ))
      if (data.state === 'installed') load()
    }

    function onOtaStatus(data) {
      setOtaState((prev) => ({ ...prev, [data.hub_mac]: { ...data, updatedAt: new Date().toISOString() } }))
      // A confirmed update changes the hub's reported version — refresh the list.
      if (data.state === 'confirmed') load()
    }

    // Re-join after a reconnect. This matters more here than elsewhere: the hub
    // reboots mid-update, and the final "confirmed" arrives minutes later.
    function onConnect() {
      hubMacsRef.current.forEach((mac) => socket.emit('join', mac))
    }

    socket.on('otaStatus', onOtaStatus)
    socket.on('sensorOtaStatus', onSensorOtaStatus)
    socket.on('connect', onConnect)
    return () => {
      socket.off('otaStatus', onOtaStatus)
      socket.off('sensorOtaStatus', onSensorOtaStatus)
      socket.off('connect', onConnect)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleUpload(e) {
    e.preventDefault()
    setError(''); setNotice('')
    if (!file) return setError('Choose a .bin file')

    setBusy(true)
    try {
      const bytes = await file.arrayBuffer()
      const params = new URLSearchParams({ version, signature, kind: 'hub', notes })
      const res = await api.post(`/firmware?${params}`, bytes, {
        headers: { 'Content-Type': 'application/octet-stream' },
      })
      setNotice(
        res.data.signature_verified === true
          ? `Uploaded ${res.data.version} — signature verified`
          : `Uploaded ${res.data.version} (server-side signature check not configured)`
      )
      setFile(null); setVersion(''); setSignature(''); setNotes('')
      e.target.reset()
      load()
    } catch (err) {
      setError(err.response?.data?.error || 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleStage(imageId, hubMac, hubVersion, imageVersion) {
    setError(''); setNotice('')
    const label = hubVersion ? `from ${hubVersion} to ${imageVersion}` : `to ${imageVersion}`
    if (!window.confirm(
      `Update ${hubMac} ${label}?\n\n` +
      'The hub will download, verify, and reboot. If the new firmware cannot ' +
      'reach the cloud, the bootloader rolls it back automatically.'
    )) return

    try {
      await api.post(`/firmware/${imageId}/stage`, { hub_mac: hubMac })
      setNotice(`Staged ${imageVersion} on ${hubMac}`)
      setOtaState((prev) => ({ ...prev, [hubMac]: { state: 'staged', version: imageVersion, pct: 0,
                                                    updatedAt: new Date().toISOString() } }))
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to stage')
    }
  }

  async function handleStageSensor(imageId, sensorMac, sensorName, imageVersion) {
    setError(''); setNotice('')
    if (!window.confirm(
      `Send ${imageVersion} to ${sensorName || sensorMac}?\n\n` +
      'The hub will hold it until someone presses the button on the node — a ' +
      'sleeping sensor only listens for an offer on a button-press wake.\n\n' +
      'The transfer takes a few seconds. If the new firmware cannot deliver a ' +
      'reading, the sensor rolls itself back.'
    )) return

    try {
      const res = await api.post(`/firmware/${imageId}/stage`, { sensor_mac: sensorMac })
      setNotice(res.data.needs_button
        ? `Staged ${imageVersion} — press the button on ${sensorName || sensorMac} to install`
        : `Staged ${imageVersion} on ${sensorMac}`)
      load()
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to stage')
    }
  }

  async function handleDelete(id, ver) {
    if (!window.confirm(`Delete firmware ${ver}? Hubs already running it are unaffected.`)) return
    try {
      await api.delete(`/firmware/${id}`)
      load()
    } catch {
      setError('Failed to delete')
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Firmware</h1>
        <p className="page-subtitle">Signed hub images and over-the-air updates</p>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-ok">{notice}</div>}

      <div className="card" style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Upload an image</h2>
        <p className="form-hint" style={{ marginBottom: 16 }}>
          Sign the build first:{' '}
          <code>node tools/firmware-signing/sign.js sign fw-signing-key.pem firmware.bin</code>,
          then paste the printed signature here. The checksum is computed here from
          the file itself.
        </p>

        <form onSubmit={handleUpload}>
          <div className="form-group">
            <label>Firmware binary (.bin)</label>
            <input
              type="file"
              accept=".bin,application/octet-stream"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Version</label>
              <input
                type="text"
                placeholder="1.1.0"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                pattern="\d{1,3}\.\d{1,3}\.\d{1,3}"
                title="Three numbers, e.g. 1.1.0"
                required
              />
              <span className="form-hint">Must match FW_VERSION compiled into the image.</span>
            </div>
            <div className="form-group">
              <label>Notes</label>
              <input
                type="text"
                placeholder="What changed"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>

          <div className="form-group">
            <label>Signature (base64)</label>
            <input
              type="text"
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              placeholder="MEQCID..."
              required
            />
          </div>

          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </form>
      </div>

      <h2 style={{ fontSize: 16, marginBottom: 12 }}>Images</h2>
      {images.length === 0 && <p className="form-hint">No firmware uploaded yet.</p>}

      <div className="devices-list">
        {images.map((img) => (
          <div className="device-card" key={img.id}>
            <div className="device-card-info">
              <div className="device-name">
                {img.version}
                <span className="chip" style={{ marginLeft: 8 }}>{img.device_kind}</span>
              </div>
              <div className="device-meta">{(img.size / 1024).toFixed(0)} KiB</div>
              <div className="device-mac" style={{ fontSize: 11 }}>{img.sha256}</div>
              {img.notes && <div className="device-meta">{img.notes}</div>}
              <div className="device-meta">
                Uploaded {new Date(img.created_at).toLocaleString()}
                {img.created_by ? ` by ${img.created_by}` : ''}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 260 }}>
              {img.device_kind === 'sensor' && (
                <span className="form-hint" style={{ marginBottom: 2 }}>
                  Staged now, installed when the node's button is pressed.
                </span>
              )}
              {img.device_kind === 'sensor' && sensors.length === 0 && (
                <span className="device-meta">No sensors paired.</span>
              )}

              {img.device_kind === 'sensor' && sensors.map((sen) => {
                const busy = sen.ota_state &&
                  !['installed', 'failed', 'declined'].includes(sen.ota_state)
                const current = sen.fw_version
                return (
                  <div key={sen.mac} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="device-meta" style={{ flex: 1 }}>
                      {sen.name || sen.mac}
                      {current ? ` · v${current}` : ' · version unknown'}
                    </span>
                    {current === img.version ? (
                      <span className="chip">installed</span>
                    ) : (
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={busy}
                        title="Delivered when the button on the node is pressed"
                        onClick={() => handleStageSensor(img.id, sen.mac, sen.name, img.version)}
                      >
                        {busy ? `${sen.ota_state}${sen.ota_pct != null ? ` ${sen.ota_pct}%` : ''}` : 'Send'}
                      </button>
                    )}
                  </div>
                )
              })}

              {img.device_kind === 'hub' && hubs.map((hub) => {
                const ota = otaState[hub.mac]
                // OTA state belongs to the hub, but a hub row is rendered inside
                // every image card. Only the card for the version actually being
                // installed should show progress; the rest just disable their
                // button, since the hub can only take one update at a time.
                // A hub that never answers would otherwise block its own Install
                // button forever — staging on an offline hub used to leave
                // "staged" in the database permanently. Anything older than the
                // rollback window is treated as abandoned rather than in flight.
                const ageMs = ota?.updatedAt ? Date.now() - new Date(ota.updatedAt).getTime() : 0
                const stale = ageMs > OTA_STALE_MS
                const busy = ota && !['confirmed', 'failed', 'uptodate'].includes(ota.state) && !stale
                const isTarget = busy && ota.version === img.version
                const current = hub.fw_version
                return (
                  <div key={hub.mac} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="device-meta" style={{ flex: 1 }}>
                      {hub.name || hub.mac}
                      {current ? ` · v${current}` : ' · version unknown'}
                    </span>
                    {current === img.version ? (
                      <span className="chip">installed</span>
                    ) : (
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={busy}
                        title={busy && !isTarget ? `Busy installing ${ota.version}` : ''}
                        onClick={() => handleStage(img.id, hub.mac, current, img.version)}
                      >
                        {isTarget
                          ? `${ota.state}${ota.pct != null ? ` ${ota.pct}%` : ''}`
                          : 'Install'}
                      </button>
                    )}
                  </div>
                )
              })}

              <button
                className="btn btn-sm btn-danger"
                style={{ marginTop: 6 }}
                onClick={() => handleDelete(img.id, img.version)}
              >
                Delete image
              </button>
            </div>
          </div>
        ))}
      </div>

      {Object.entries(otaState).some(([, o]) => o?.error) && (
        <>
          <h2 style={{ fontSize: 16, margin: '24px 0 12px' }}>Recent failures</h2>
          {Object.entries(otaState)
            .filter(([, o]) => o?.error)
            .map(([mac, o]) => (
              <div className="alert alert-error" key={mac}>
                {mac} — {o.state}: {o.error}
              </div>
            ))}
        </>
      )}
    </div>
  )
}
