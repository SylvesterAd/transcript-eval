import db from '../db.js'

/**
 * Fetch wrapper that logs the request and response to api_logs table.
 * Drop-in replacement for fetch() — same signature, same return value.
 *
 * @param {string} url
 * @param {RequestInit & { logSource?: string }} opts - standard fetch options + optional logSource tag
 */
export async function loggedFetch(url, opts = {}) {
  const { logSource, ...fetchOpts } = opts
  const method = (fetchOpts.method || 'GET').toUpperCase()

  // Redact auth headers for storage
  const safeHeaders = { ...fetchOpts.headers }
  if (safeHeaders['X-Internal-Key']) safeHeaders['X-Internal-Key'] = '***'
  if (safeHeaders['Authorization']) safeHeaders['Authorization'] = '***'

  const start = Date.now()
  let response
  let responseBody = null
  let responseStatus = null
  let error = null

  try {
    response = await fetch(url, fetchOpts)
    responseStatus = response.status

    // Clone so caller can still read the body
    const cloned = response.clone()
    try {
      responseBody = await cloned.text()
      // Truncate huge responses
      if (responseBody.length > 50000) {
        responseBody = responseBody.substring(0, 50000) + '...[truncated]'
      }
    } catch {}
  } catch (err) {
    error = err.message || String(err)
  }

  const duration = Date.now() - start

  // Fire-and-forget DB insert
  db.prepare(
    `INSERT INTO api_logs (method, url, request_headers, request_body, response_status, response_body, error, duration_ms, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`
  ).run(
    method,
    url,
    JSON.stringify(safeHeaders),
    typeof fetchOpts.body === 'string' ? fetchOpts.body : null,
    responseStatus,
    responseBody,
    error,
    duration,
    logSource || null,
  ).catch(err => console.warn('[api-logger] Failed to log:', err.message))

  if (error && !response) {
    throw new Error(error)
  }

  return response
}
