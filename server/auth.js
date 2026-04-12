import { createRemoteJWKSet, jwtVerify } from 'jose'

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const issuer = supabaseUrl ? `${supabaseUrl}/auth/v1` : null
const jwks = issuer ? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)) : null

export const hasServerAuthConfig = Boolean(issuer && jwks)

async function verifyAccessToken(token) {
  if (!jwks || !issuer) {
    throw new Error('Supabase auth verification is not configured')
  }

  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience: 'authenticated',
  })

  return payload
}

function parseBearerToken(header) {
  if (!header) return null
  const [scheme, token] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null
  return token
}

export async function attachAuth(req, _res, next) {
  req.auth = null

  const token = parseBearerToken(req.headers.authorization)
  if (!token) {
    next()
    return
  }

  try {
    const payload = await verifyAccessToken(token)
    req.auth = {
      token,
      userId: payload.sub,
      email: payload.email || null,
      role: payload.role || payload.user_metadata?.role || payload.app_metadata?.role || 'authenticated',
      payload,
    }
  } catch (error) {
    req.authError = error
  }

  next()
}

const ADMIN_EMAILS = ['silvestras.stonk@gmail.com']

export function isAdmin(req) {
  if (!req.auth) return false
  // Check hardcoded email list (owner fallback)
  if (req.auth.email && ADMIN_EMAILS.includes(req.auth.email.toLowerCase())) return true
  // Check app_metadata.role set via Supabase dashboard
  if (req.auth.payload?.app_metadata?.role === 'admin') return true
  return false
}

export function requireAuth(req, res, next) {
  if (!hasServerAuthConfig) {
    return res.status(503).json({ error: 'Server auth is not configured' })
  }

  // Dev bypass: allow unauthenticated requests on localhost with X-Dev-Bypass header
  if (process.env.NODE_ENV !== 'production' && req.headers['x-dev-bypass'] === 'true') {
    req.auth = { userId: 'dev', email: ADMIN_EMAILS[0], role: 'authenticated' }
    return next()
  }

  if (req.auth) {
    return next()
  }

  if (req.authError) {
    return res.status(401).json({ error: 'Invalid or expired session' })
  }

  return res.status(401).json({ error: 'Authentication required' })
}
