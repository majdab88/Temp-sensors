import { useEffect, useState } from 'react'
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
export default function Firmware() {
  const [images, setImages] = useState([])
  const [hubs, setHubs] = useState([])
  const [otaState, setOtaState] = useState({})   // hub_mac -> latest ota/status
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [file, setFile] = useState(null)
  const [version, setVersion] = useState('')
  const [signature, setSignature] = useState('')
  const [notes, setNotes] = useState('')

  async function load() {
    try {
      const [fwRes, devRes] = await Promise.all([
        api.get('/firmware'),
        api.get('/devices'),
      ])
      setImages(fwRes.data)
      setHubs(devRes.data)

      // Seed from stored state so a refresh mid-update still shows progress.
      const seeded = {}
      for (const d of devRes.data) {
        if (d.ota_state) {
          seeded[d.mac] = { state: d.ota_state, version: d.ota_version, pct: d.ota_pct, error: d.ota_error }
        }
      }
      setOtaState(seeded)
      devRes.data.forEach((d) => socket.emit('join', d.mac))
    } catch {
      setError('Failed to load firmware registry')
    }
  }

  useEffect(() => {
    load()

    function onOtaStatus(data) {
      setOtaState((prev) => ({ ...prev, [data.hub_mac]: data }))
      // A confirmed update changes the hub's reported version — refresh the list.
      if (data.state === 'confirmed') load()
    }
    socket.on('otaStatus', onOtaStatus)
    return () => socket.off('otaStatus', onOtaStatus)
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
      setOtaState((prev) => ({ ...prev, [hubMac]: { state: 'staged', version: imageVersion, pct: 0 } }))
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
              {hubs.map((hub) => {
                const ota = otaState[hub.mac]
                const active = ota && !['confirmed', 'failed', 'uptodate'].includes(ota.state)
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
                        disabled={active}
                        onClick={() => handleStage(img.id, hub.mac, current, img.version)}
                      >
                        {active ? `${ota.state}${ota.pct != null ? ` ${ota.pct}%` : ''}` : 'Install'}
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
