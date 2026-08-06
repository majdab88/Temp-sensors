import api from './api'

// Download an authenticated file (CSV, etc.) through the axios instance so the
// JWT + impersonation interceptors attach — a plain <a href> can't carry the
// Authorization header, so it would 401.
export async function downloadFile(url, params, fallbackName = 'export.csv') {
  const res = await api.get(url, { params, responseType: 'blob' })
  const cd = res.headers['content-disposition'] || ''
  const m = /filename="?([^"]+)"?/.exec(cd)
  const name = m ? m[1] : fallbackName
  const href = URL.createObjectURL(res.data)
  const a = document.createElement('a')
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(href)
}
