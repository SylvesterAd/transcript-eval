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

export function useApi(path, deps = []) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(!!path)
  const [error, setError] = useState(null)

  const refetch = useCallback((silent) => {
    if (!path) { setLoading(false); return }
    if (!silent) { setLoading(true); setError(null) }
    getAuthHeaders().then(headers =>
      fetch(`${BASE}${path}`, { headers })
    )
      .then(r => {
        if (!r.ok) {
          handleUnauthorized(r)
          throw new Error(`${r.status} ${r.statusText}`)
        }
        return r.json()
      })
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
