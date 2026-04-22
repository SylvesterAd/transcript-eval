import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient.js'

const BASE = import.meta.env.VITE_API_URL || '/api'

async function getAuthHeaders(extraHeaders = {}) {
  if (!supabase) return extraHeaders

  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return extraHeaders

  return {
    ...extraHeaders,
    Authorization: `Bearer ${token}`,
  }
}

function handleUnauthorized(res) {
  if (res.status === 401 && supabase) {
    supabase.auth.signOut()
  }
}

async function fetchWithRetry(path, maxAttempts = 3) {
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const headers = await getAuthHeaders()
      const res = await fetch(`${BASE}${path}`, { headers })
      if (res.status === 401) {
        handleUnauthorized(res)
        throw new Error('401 Unauthorized')
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      return await res.json()
    } catch (e) {
      lastErr = e
      // Don't retry auth errors — they won't succeed by retrying
      if (e.message.startsWith('401')) break
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 300 * Math.pow(2, attempt - 1)))
      }
    }
  }
  throw lastErr
}

export function useApi(path, deps = []) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(!!path)
  const [error, setError] = useState(null)

  const refetch = useCallback((silent) => {
    if (!path) { setLoading(false); return }
    if (!silent) { setLoading(true); setError(null) }
    fetchWithRetry(path)
      .then(setData)
      .catch(e => { if (!silent) setError(e.message) })
      .finally(() => { if (!silent) setLoading(false) })
  }, [path])

  useEffect(() => { refetch() }, [refetch, ...deps])

  const mutate = useCallback((updater) => {
    setData(prev => typeof updater === 'function' ? updater(prev) : updater)
  }, [])

  return { data, loading, error, refetch, mutate }
}

export async function apiPost(path, body) {
  const headers = await getAuthHeaders({ 'Content-Type': 'application/json' })
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    handleUnauthorized(res)
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}

export async function apiPut(path, body) {
  const headers = await getAuthHeaders({ 'Content-Type': 'application/json' })
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    handleUnauthorized(res)
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}

export async function apiGet(path) {
  const headers = await getAuthHeaders()
  const res = await fetch(`${BASE}${path}`, { headers })
  if (!res.ok) {
    handleUnauthorized(res)
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}

export async function apiDelete(path) {
  const headers = await getAuthHeaders()
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers })
  if (!res.ok) {
    handleUnauthorized(res)
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}
