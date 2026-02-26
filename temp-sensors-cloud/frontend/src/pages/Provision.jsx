import React, { useEffect, useRef, useState } from 'react'
import api from '../services/api'

// ── GATT UUIDs — must match hub firmware ──────────────────────────────────────
const SERVICE_UUID  = '4fafc201-1fb5-459e-8fcc-c5c9c331914b'
const CHAR_WIFI     = 'beb5483e-36e1-4688-b7f5-ea07361b26a8'  // write {ssid,pass}
const CHAR_CLOUD    = '1c95d5e3-d8f7-413a-bf3d-7a2e5d7be87e'  // write {host,port,user,pass}
const CHAR_STATUS   = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'  // notify {state,detail}
const CHAR_NETWORKS = 'd5913036-2d8a-41ee-85b9-4e361aa5c8a3'  // write 0x01→scan; notify network list
const CHAR_INFO     = 'a9b12301-bc5d-4e8a-9c23-c5d1b3f4a5e6'  // read  {mac} — optional firmware feature

const MAC_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/

export default function Provision() {
  // ── BLE object refs (stable across renders, no re-render on change) ──────────
  const charWifiRef   = useRef(null)
  const charCloudRef  = useRef(null)
  const charStatusRef = useRef(null)
  const charNetsRef   = useRef(null)
  const bleServerRef  = useRef(null)

  // ── State ─────────────────────────────────────────────────────────────────────
  const [bleState, setBleState]           = useState('idle')        // idle | connecting | connected
  const [deviceName, setDeviceName]       = useState('')
  const [hasNetScan, setHasNetScan]       = useState(false)
  const [macAuto, setMacAuto]             = useState(false)          // true if CHAR_INFO gave us the MAC

  const [mac, setMac]                     = useState('')
  const [nickname, setNickname]           = useState('')
  const [apiKey, setApiKey]               = useState('')
  const [registering, setRegistering]     = useState(false)

  const [mqttHost, setMqttHost]           = useState('')
  const [mqttPort, setMqttPort]           = useState(8883)
  const [mqttUser, setMqttUser]           = useState('')
  const [mqttPass, setMqttPass]           = useState('')
  const [mqttConfigErr, setMqttConfigErr] = useState(false)

  const [networks, setNetworks]           = useState([])
  const [scanBusy, setScanBusy]           = useState(false)
  const [selectedSsid, setSelectedSsid]   = useState(null)
  const [isOpenNet, setIsOpenNet]         = useState(false)
  const [wifiPass, setWifiPass]           = useState('')
  const [showPass, setShowPass]           = useState(false)
  const [manualSsid, setManualSsid]       = useState('')

  const [provState, setProvState]         = useState('idle')   // idle|sending|waiting|done|failed
  const [logs, setLogs]                   = useState([])

  const bleSupported = typeof navigator !== 'undefined' && 'bluetooth' in navigator

  // ── Fetch MQTT broker config from VPS on mount ───────────────────────────────
  useEffect(() => {
    api.get('/provision/config')
      .then(r => {
        if (r.data.mqttHost && r.data.mqttUser) {
          setMqttHost(r.data.mqttHost)
          setMqttPort(r.data.mqttPort || 8883)
          setMqttUser(r.data.mqttUser)
          setMqttPass(r.data.mqttPass)
        } else {
          setMqttConfigErr(true)
        }
      })
      .catch(() => setMqttConfigErr(true))
  }, [])

  // ── Logging ──────────────────────────────────────────────────────────────────
  function addLog(msg, type = '') {
    setLogs(prev => [...prev.slice(-99), { ts: new Date().toLocaleTimeString(), msg, type }])
  }

  // ── BLE connect ──────────────────────────────────────────────────────────────
  async function connect() {
    setBleState('connecting')
    addLog('Scanning for TempHub devices…', 'inf')
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }],
      })
      device.addEventListener('gattserverdisconnected', handleDisconnect)
      addLog(`Found: ${device.name}`, 'inf')

      const server  = await device.gatt.connect()
      const service = await server.getPrimaryService(SERVICE_UUID)

      charWifiRef.current   = await service.getCharacteristic(CHAR_WIFI)
      charCloudRef.current  = await service.getCharacteristic(CHAR_CLOUD)
      charStatusRef.current = await service.getCharacteristic(CHAR_STATUS)
      await charStatusRef.current.startNotifications()
      charStatusRef.current.addEventListener('characteristicvaluechanged', handleStatusNotify)

      // Optional: WiFi network scan
      try {
        charNetsRef.current = await service.getCharacteristic(CHAR_NETWORKS)
        await charNetsRef.current.startNotifications()
        charNetsRef.current.addEventListener('characteristicvaluechanged', handleNetworksNotify)
        setHasNetScan(true)
        addLog('WiFi scan available', 'ok')
      } catch {
        charNetsRef.current = null
        setHasNetScan(false)
        addLog('WiFi scan not supported by firmware — enter SSID manually', 'inf')
      }

      // Optional: CHAR_INFO — read device MAC automatically
      try {
        const charInfo = await service.getCharacteristic(CHAR_INFO)
        const raw = await charInfo.readValue()
        const info = JSON.parse(new TextDecoder().decode(raw))
        if (info.mac && MAC_RE.test(info.mac)) {
          setMac(info.mac.toUpperCase())
          setMacAuto(true)
          addLog(`Device MAC: ${info.mac}`, 'ok')
        }
      } catch (e) {
        addLog(`CHAR_INFO not available (${e.message}) — enter MAC manually`, 'inf')
      }

      bleServerRef.current = server
      setDeviceName(device.name || 'Unknown')
      setNickname(device.name || '')
      setBleState('connected')
      addLog('Ready to provision', 'ok')

      if (charNetsRef.current) doScan(charNetsRef.current)
    } catch (err) {
      addLog(`Connection failed: ${err.message}`, 'err')
      setBleState('idle')
    }
  }

  function handleDisconnect() {
    addLog('Device disconnected', 'err')
    bleServerRef.current = null
    charWifiRef.current = charCloudRef.current = charStatusRef.current = charNetsRef.current = null
    setBleState('idle')
    setHasNetScan(false)
    setNetworks([])
    setScanBusy(false)
    setSelectedSsid(null)
    setWifiPass('')
    setProvState('idle')
  }

  function disconnect() {
    bleServerRef.current?.disconnect()
  }

  // ── WiFi scan ────────────────────────────────────────────────────────────────
  async function doScan(char = charNetsRef.current) {
    if (!char || scanBusy) return
    setScanBusy(true)
    setNetworks([])
    addLog('Requesting WiFi scan…', 'inf')
    try {
      await char.writeValueWithResponse(new Uint8Array([0x01]))
      // Results arrive via CHAR_NETWORKS notification → handleNetworksNotify
    } catch (err) {
      addLog(`Scan failed: ${err.message}`, 'err')
      setScanBusy(false)
    }
  }

  function handleNetworksNotify(event) {
    setScanBusy(false)
    try {
      const raw = new TextDecoder().decode(event.target.value)
      const { networks: nets = [] } = JSON.parse(raw)
      setNetworks([...nets].sort((a, b) => b.rssi - a.rssi))
      addLog(`Found ${nets.length} network(s)`, 'ok')
    } catch {
      addLog('Could not parse network list', 'err')
    }
  }

  // ── Status notifications from hub ────────────────────────────────────────────
  function handleStatusNotify(event) {
    try {
      const raw = new TextDecoder().decode(event.target.value)
      addLog(`Hub: ${raw}`, 'inf')
      const { state, detail } = JSON.parse(raw)
      if (state === 'connected') {
        setProvState('done')
        addLog('Provisioning complete!', 'ok')
      } else if (state === 'failed') {
        setProvState('failed')
        addLog(`Failed: ${detail || 'unknown reason'}`, 'err')
      } else if (state === 'connecting') {
        setProvState('waiting')
      }
    } catch {
      addLog('Could not parse status notification', 'err')
    }
  }

  // ── Register device with cloud ───────────────────────────────────────────────
  async function register() {
    const normMac = mac.trim().toUpperCase()
    if (!MAC_RE.test(normMac)) return
    setRegistering(true)
    addLog('Registering device with cloud…', 'inf')
    try {
      const { data } = await api.post('/devices/register', {
        mac: normMac,
        name: nickname.trim() || null,
      })
      setApiKey(data.api_key)
      addLog('Device registered — API key received', 'ok')
    } catch (err) {
      addLog(`Registration failed: ${err.response?.data?.error || err.message}`, 'err')
    } finally {
      setRegistering(false)
    }
  }

  // ── Provision ────────────────────────────────────────────────────────────────
  async function provision() {
    const ssid = selectedSsid || manualSsid.trim()
    if (!ssid || !apiKey) return
    setProvState('sending')
    addLog(`Sending credentials for "${ssid}"…`, 'inf')
    try {
      const pass = (isOpenNet && selectedSsid) ? '' : wifiPass
      await writeChar(charWifiRef.current, JSON.stringify({ ssid, pass }))
      addLog('WiFi credentials written', 'ok')

      // Send shared MQTT credentials from the VPS (not per-device MAC/api_key).
      // The hub MAC is embedded in the topic path by the firmware; the broker
      // identifies each device from the topic, not the MQTT username.
      await writeChar(charCloudRef.current, JSON.stringify({
        host: mqttHost,
        port: mqttPort,
        user: mqttUser,
        pass: mqttPass,
      }))
      addLog('Cloud credentials written — waiting for hub to connect…', 'ok')
      setProvState('waiting')
    } catch (err) {
      addLog(`Error: ${err.message}`, 'err')
      setProvState('failed')
    }
  }

  async function writeChar(char, jsonString) {
    const encoded = new TextEncoder().encode(jsonString)
    for (let i = 0; i < encoded.length; i += 512) {
      await char.writeValueWithResponse(encoded.slice(i, i + 512))
    }
  }

  // ── Reset / start over ───────────────────────────────────────────────────────
  function resetAll() {
    disconnect()
    setMac(''); setNickname(''); setApiKey(''); setMacAuto(false)
    setNetworks([]); setSelectedSsid(null); setIsOpenNet(false)
    setWifiPass(''); setManualSsid(''); setLogs([]); setProvState('idle')
  }

  function rssiToBars(rssi) {
    if (rssi >= -50) return 4
    if (rssi >= -60) return 3
    if (rssi >= -70) return 2
    return 1
  }

  // ── Derived ──────────────────────────────────────────────────────────────────
  const macValid    = MAC_RE.test(mac.trim())
  const ssidChosen  = !!(selectedSsid || manualSsid.trim())
  const canProvision = bleState === 'connected' && !!apiKey && ssidChosen
    && provState !== 'sending' && provState !== 'waiting' && provState !== 'done'

  // ── Browser not supported ───────────────────────────────────────────────────
  if (!bleSupported) {
    return (
      <div>
        <h2 className="page-title">Setup New Hub</h2>
        <div className="card">
          <div className="prov-compat-warning">
            <strong>Web Bluetooth not supported</strong>
            <p>
              This page requires <strong>Chrome or Edge</strong> on Android, Windows, or macOS.
              Safari and Firefox do not support Web Bluetooth.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // ── Success screen ───────────────────────────────────────────────────────────
  if (provState === 'done') {
    return (
      <div>
        <h2 className="page-title">Setup New Hub</h2>
        <div className="card prov-success-card">
          <div className="prov-success-icon">✓</div>
          <h3>Device Ready!</h3>
          <p>Your hub is connected to WiFi and the cloud. It will appear in the Devices page shortly.</p>
          <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={resetAll}>
            Set Up Another Device
          </button>
        </div>
      </div>
    )
  }

  // ── Main provisioning UI ─────────────────────────────────────────────────────
  return (
    <div>
      <h2 className="page-title">Setup New Hub</h2>

      {mqttConfigErr && (
        <div className="alert alert-error" style={{ marginBottom: 16 }}>
          Could not load MQTT broker config from the server. Check that{' '}
          <code>MQTT_URL</code> is set in your backend environment.
        </div>
      )}

      {/* ── Step 1: Find Device ──────────────────────────────────────────── */}
      <div className={`card prov-card ${bleState === 'connected' ? 'prov-step-done' : 'prov-step-active'}`}>
        <div className="prov-step-hdr">
          <span className={`prov-step-num ${bleState === 'connected' ? 'done' : 'active'}`}>
            {bleState === 'connected' ? '✓' : '1'}
          </span>
          <h3>Find Your Device</h3>
        </div>

        {bleState === 'connected' ? (
          <div className="prov-connected-row">
            <span className="prov-device-name">{deviceName}</span>
            <button className="btn btn-ghost btn-sm" onClick={disconnect}>Disconnect</button>
          </div>
        ) : (
          <button
            className="btn btn-primary"
            onClick={connect}
            disabled={bleState === 'connecting'}
          >
            {bleState === 'connecting' ? 'Connecting…' : 'Scan for Devices'}
          </button>
        )}
      </div>

      {/* ── Step 2: Register Device ──────────────────────────────────────── */}
      <div className={`card prov-card ${
        bleState !== 'connected'  ? 'prov-step-locked' :
        apiKey                    ? 'prov-step-done'   : 'prov-step-active'
      }`}>
        <div className="prov-step-hdr">
          <span className={`prov-step-num ${
            bleState !== 'connected' ? '' : apiKey ? 'done' : 'active'
          }`}>
            {apiKey ? '✓' : '2'}
          </span>
          <h3>Register Device</h3>
        </div>

        {bleState === 'connected' && !apiKey && (
          <>
            <div className="form-group">
              <label>Hub MAC Address</label>
              <input
                type="text"
                value={mac}
                onChange={e => setMac(e.target.value)}
                placeholder="AA:BB:CC:DD:EE:FF"
                readOnly={macAuto}
              />
              {macAuto && (
                <p className="form-hint">Auto-detected from device.</p>
              )}
              {!macAuto && deviceName && (
                <p className="form-hint">
                  Hint: device name is <code>{deviceName}</code>. Find the full MAC in the
                  Arduino Serial Monitor or on a label on the device.
                </p>
              )}
            </div>
            <div className="form-group" style={{ marginTop: 12 }}>
              <label>Device Name <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>(optional)</span></label>
              <input
                type="text"
                value={nickname}
                onChange={e => setNickname(e.target.value)}
                placeholder="e.g. Living Room Hub"
              />
            </div>
            <button
              className="btn btn-primary"
              style={{ marginTop: 16 }}
              onClick={register}
              disabled={!macValid || registering}
            >
              {registering ? 'Registering…' : 'Register with Cloud'}
            </button>
          </>
        )}

        {apiKey && (
          <div className="prov-registered-row">
            <code className="prov-mac">{mac.toUpperCase()}</code>
            {nickname && <span className="prov-nickname">{nickname}</span>}
            <span className="prov-badge-ok">Registered</span>
          </div>
        )}
      </div>

      {/* ── Step 3: WiFi Network ─────────────────────────────────────────── */}
      <div className={`card prov-card ${
        !apiKey      ? 'prov-step-locked' :
        ssidChosen   ? 'prov-step-done'   : 'prov-step-active'
      }`}>
        <div className="prov-step-hdr">
          <span className={`prov-step-num ${
            !apiKey ? '' : ssidChosen ? 'done' : 'active'
          }`}>
            {ssidChosen ? '✓' : '3'}
          </span>
          <h3>WiFi Network</h3>
        </div>

        {apiKey && (
          <>
            <div className="prov-scan-hdr">
              <span className="prov-scan-label">Select your network</span>
              {hasNetScan && (
                <button className="btn btn-ghost btn-sm" onClick={() => doScan()} disabled={scanBusy}>
                  {scanBusy ? 'Scanning…' : '⟳ Refresh'}
                </button>
              )}
            </div>

            {scanBusy && (
              <div className="prov-scan-placeholder">
                <div className="prov-scan-spinner" />
                Scanning for networks…
              </div>
            )}

            {!hasNetScan && !scanBusy && (
              <p className="form-hint" style={{ marginBottom: 8 }}>
                WiFi scan not available in this firmware version — enter the network name below.
              </p>
            )}

            {!scanBusy && networks.length > 0 && (
              <div className="prov-network-list">
                {networks.map(net => {
                  const bars = rssiToBars(net.rssi)
                  const open = net.enc === 0
                  const sel  = selectedSsid === net.ssid
                  return (
                    <div
                      key={net.ssid}
                      className={`prov-network-item${sel ? ' selected' : ''}`}
                      onClick={() => {
                        setSelectedSsid(net.ssid)
                        setIsOpenNet(open)
                        setManualSsid('')
                      }}
                    >
                      <div className="prov-radio"><div className="prov-radio-dot" /></div>
                      <span className="prov-ssid">{net.ssid}</span>
                      <div className="prov-bars">
                        {[1, 2, 3, 4].map(b => (
                          <div key={b} className={`prov-bar h${b}${bars >= b ? ' active' : ''}`} />
                        ))}
                      </div>
                      <span className="prov-lock">{open ? '🔓' : '🔒'}</span>
                    </div>
                  )
                })}
              </div>
            )}

            <div className="form-group" style={{ marginTop: 10 }}>
              <label>{networks.length > 0 ? 'Or enter manually' : 'Network name (SSID)'}</label>
              <input
                type="text"
                value={manualSsid}
                onChange={e => { setManualSsid(e.target.value); setSelectedSsid(null) }}
                placeholder="Network name…"
              />
            </div>

            {((selectedSsid && !isOpenNet) || (manualSsid && !selectedSsid)) && (
              <div className="form-group" style={{ marginTop: 10 }}>
                <label>Password</label>
                <div className="prov-pass-wrap">
                  <input
                    type={showPass ? 'text' : 'password'}
                    value={wifiPass}
                    onChange={e => setWifiPass(e.target.value)}
                    placeholder="WiFi password"
                    autoComplete="current-password"
                  />
                  <button
                    className="prov-pass-toggle"
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowPass(v => !v)}
                  >
                    {showPass ? '🙈' : '👁'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Step 4: Provision ────────────────────────────────────────────── */}
      <div className={`card prov-card ${
        !ssidChosen || !apiKey ? 'prov-step-locked' : 'prov-step-active'
      }`}>
        <div className="prov-step-hdr">
          <span className={`prov-step-num ${ssidChosen && apiKey ? 'active' : ''}`}>4</span>
          <h3>Provision Device</h3>
        </div>

        {ssidChosen && apiKey && (
          <>
            <div className="prov-mqtt-box">
              <div className="prov-mqtt-row">
                <span className="prov-mqtt-label">Broker</span>
                <span className="prov-mqtt-val">{mqttHost || <em>not configured</em>}</span>
              </div>
              <div className="prov-mqtt-row">
                <span className="prov-mqtt-label">Port</span>
                <span className="prov-mqtt-val">{mqttPort}</span>
              </div>
              <div className="prov-mqtt-row">
                <span className="prov-mqtt-label">User</span>
                <code className="prov-mqtt-val">{mqttUser}</code>
              </div>
              <div className="prov-mqtt-row">
                <span className="prov-mqtt-label">Pass</span>
                <span className="prov-mqtt-val">••••••••</span>
              </div>
            </div>

            <button
              className="btn btn-success"
              style={{ marginTop: 16, width: '100%' }}
              onClick={provision}
              disabled={!canProvision}
            >
              {provState === 'sending'  ? 'Sending credentials…' :
               provState === 'waiting' ? 'Waiting for hub…'     : 'Provision Device'}
            </button>

            {provState !== 'idle' && (
              <div style={{ marginTop: 12 }}>
                <span className={`prov-status-pill ${provState}`}>
                  <span className={`prov-dot${provState === 'sending' || provState === 'waiting' ? ' pulse' : ''}`} />
                  {provState === 'sending' ? 'Sending credentials'   :
                   provState === 'waiting' ? 'Connecting to cloud…'  :
                   provState === 'failed'  ? 'Failed — check log'    : ''}
                </span>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Activity log ─────────────────────────────────────────────────── */}
      {logs.length > 0 && (
        <div className="prov-log">
          {logs.map((l, i) => (
            <div key={i} className={`prov-log-line ${l.type}`}>
              <span className="prov-log-ts">{l.ts}</span>
              <span>{l.type === 'ok' ? '✓' : l.type === 'err' ? '✗' : '→'} {l.msg}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
