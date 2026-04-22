import db from '../db.js'
import { notify } from './slack-notifier.js'

// ── Active streams (in-memory, for live UI) ──────────────────────────
export const activeStreams = new Map()

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

  if ((responseStatus && responseStatus >= 400) || error) {
    notify({
      source: 'api-log',
      title: error ? 'Fetch threw' : `HTTP ${responseStatus}`,
      error: error || null,
      meta: {
        method,
        url: url.length > 200 ? url.slice(0, 200) + '…' : url,
        status: responseStatus,
        logSource: logSource || null,
        duration_ms: duration,
      },
    })
  }

  if (error && !response) {
    throw new Error(error)
  }

  return response
}

/**
 * SSE streaming fetch — sends request with stream:true, parses SSE events,
 * calls onProgress for each progress event, and returns the final result.
 *
 * @param {string} url
 * @param {object} opts
 * @param {object} opts.body - request body (stream:true is added automatically)
 * @param {object} opts.headers - request headers
 * @param {AbortSignal} [opts.signal] - abort signal
 * @param {string} [opts.logSource] - tag for api_logs
 * @param {(event: {stage: string, status: string}) => void} [opts.onProgress] - called for each progress event
 * @returns {Promise<{results: any[], search_count: number, filtered_count: number, model_used: string, events: object[]}>}
 */
export async function streamingFetch(url, opts = {}) {
  const { body, headers, signal, logSource, onProgress } = opts
  const method = 'POST'

  const requestBody = { ...body, stream: true }
  const requestStr = JSON.stringify(requestBody)

  // Redact auth headers for storage
  const safeHeaders = { ...headers }
  if (safeHeaders['X-Internal-Key']) safeHeaders['X-Internal-Key'] = '***'
  if (safeHeaders['Authorization']) safeHeaders['Authorization'] = '***'

  const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const start = Date.now()
  const allEvents = []
  let finalResult = null
  let errorEvent = null
  let responseStatus = null

  // Register as active stream for live UI
  activeStreams.set(streamId, {
    id: streamId,
    method,
    url,
    request_body: requestStr,
    source: logSource || null,
    started_at: new Date().toISOString(),
    status: 'connecting',
    events: [],
  })

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: requestStr,
      signal,
    })
    responseStatus = response.status

    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${response.status}`)
    }

    const contentType = response.headers.get('content-type') || ''

    if (contentType.includes('text/event-stream')) {
      activeStreams.set(streamId, { ...activeStreams.get(streamId), status: 'streaming', response_status: responseStatus })

      // Parse SSE stream
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      let lastEventTime = Date.now()
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          console.log(`[streamingFetch] SSE stream ended normally after ${((Date.now() - start) / 1000).toFixed(1)}s, ${allEvents.length} events`)
          break
        }
        lastEventTime = Date.now()

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() // keep incomplete line in buffer

        let currentEvent = {}
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent.event = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim()
            try { currentEvent.data = JSON.parse(dataStr) } catch { currentEvent.data = dataStr }
          } else if (line === '' && currentEvent.event) {
            // End of event block
            const timestamped = { ...currentEvent, received_at: new Date().toISOString() }
            allEvents.push(timestamped)

            // Update active stream with new event
            const active = activeStreams.get(streamId)
            if (active) {
              active.events.push(timestamped)
              if (currentEvent.event === 'progress') {
                active.lastStage = currentEvent.data?.stage
                active.lastStatus = currentEvent.data?.status
              }
            }

            if (currentEvent.event === 'progress' && onProgress) {
              onProgress(currentEvent.data)
              // Capture job_id from the first progress event
              if (currentEvent.data?.stage === 'job' && currentEvent.data?.job_id) {
                if (!finalResult) finalResult = {}
                finalResult.job_id = currentEvent.data.job_id
              }
            } else if (currentEvent.event === 'stage_result') {
              // Store intermediate stage results (search candidates, SigLIP filtered)
              if (!finalResult) finalResult = {}
              if (!finalResult.stages) finalResult.stages = {}
              finalResult.stages[currentEvent.data.stage] = currentEvent.data
              if (onProgress) onProgress(currentEvent.data)
            } else if (currentEvent.event === 'result') {
              finalResult = { ...(finalResult || {}), ...currentEvent.data }
            } else if (currentEvent.event === 'error') {
              errorEvent = currentEvent.data
            }
            currentEvent = {}
          }
        }
      }
    } else {
      // Non-streaming fallback (server didn't stream)
      activeStreams.set(streamId, { ...activeStreams.get(streamId), status: 'non-streaming', response_status: responseStatus })
      const data = await response.json()
      finalResult = data
    }
  } catch (err) {
    console.error(`[streamingFetch] ERROR after ${((Date.now() - start) / 1000).toFixed(1)}s, ${allEvents.length} events: ${err.name}: ${err.message}`)
    if (err.name === 'AbortError') {
      activeStreams.delete(streamId)
      throw err
    }
    errorEvent = { error: err.message }
  }

  const duration = Date.now() - start

  // Remove from active streams
  activeStreams.delete(streamId)

  // Log the full exchange to DB and capture the log ID
  const responseBody = JSON.stringify({ events: allEvents, result: finalResult, error: errorEvent })
  let apiLogId = null
  try {
    const logResult = await db.prepare(
      `INSERT INTO api_logs (method, url, request_headers, request_body, response_status, response_body, error, duration_ms, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`
    ).run(
      method,
      url,
      JSON.stringify(safeHeaders),
      requestStr,
      responseStatus,
      responseBody.length > 50000 ? responseBody.substring(0, 50000) + '...[truncated]' : responseBody,
      errorEvent ? (errorEvent.error || JSON.stringify(errorEvent)) : null,
      duration,
      logSource || null,
    )
    apiLogId = logResult.lastInsertRowid
  } catch (err) {
    console.warn('[api-logger] Failed to log:', err.message)
  }

  if (errorEvent || (responseStatus && responseStatus >= 400)) {
    notify({
      source: 'api-log',
      title: errorEvent ? 'Stream error' : `HTTP ${responseStatus}`,
      error: errorEvent?.error || null,
      meta: {
        method,
        url: url.length > 200 ? url.slice(0, 200) + '…' : url,
        status: responseStatus,
        logSource: logSource || null,
        duration_ms: duration,
        apiLogId,
      },
    })
  }

  if (errorEvent && !finalResult) {
    const err = new Error(errorEvent.error || JSON.stringify(errorEvent))
    err.apiLogId = apiLogId
    throw err
  }

  return { ...finalResult, events: allEvents, apiLogId }
}
