import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient.js'

const BASE = '/api'

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

export function useApi(path, deps = []) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(!!path)
  const [error, setError] = useState(null)

  const refetch = useCallback((silent) => {
    if (!path) { setLoading(false); return }
    if (!silent) { setLoading(true); setError(null) }
    fetch(`${BASE}${path}`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
        return r.json()
      })
      .then(setData)
      .catch(e => { if (!silent) setError(e.message) })
      .finally(() => { if (!silent) setLoading(false) })
  }, [path])

  useEffect(() => { refetch() }, [refetch, ...deps])

  return { data, loading, error, refetch }
}

export async function apiPost(path, body) {
  const headers = await getAuthHeaders({ 'Content-Type': 'application/json' })
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  if (!res.ok) {
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
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}

export async function apiDelete(path) {
  const headers = await getAuthHeaders()
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  return res.json()
}
