// server/services/supabase-admin.js
//
// Backend-only Supabase Admin API client. Used by /api/admin/users to
// list/inspect users. The service-role key bypasses RLS and CAN read
// every user — never expose this client outside the backend.
//
// Lazy singleton: created on first call so the server can boot when
// SUPABASE_SERVICE_ROLE_KEY is unset (the admin route returns 503
// instead, see routes/admin/users.js).

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

let client = null

export function hasSupabaseAdminConfig() {
  return Boolean(supabaseUrl && serviceRoleKey)
}

export function getSupabaseAdmin() {
  if (!hasSupabaseAdminConfig()) {
    throw new Error('Supabase admin client requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
  }
  if (!client) {
    // autoRefreshToken / persistSession off — server-side, no user session
    // to refresh and no localStorage to persist into.
    client = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  }
  return client
}
