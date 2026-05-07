// Get a session token for the test user via service-role admin API.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = readFileSync('/Users/laurynas/Desktop/one last /transcript-eval/.env', 'utf8')
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}

const supabaseUrl = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SECRET_KEY
const email = 'silvestras.stonk@gmail.com'

const admin = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const { data, error } = await admin.auth.admin.generateLink({
  type: 'magiclink',
  email,
})
if (error) { console.error('generateLink failed:', error); process.exit(1) }

const hashedToken = data.properties.hashed_token

// Try via the SDK using anon key (verifyOtp uses that path)
const anon = createClient(supabaseUrl, process.env.VITE_SUPABASE_PUBLISHABLE_KEY)
const verifyResult = await anon.auth.verifyOtp({
  email,
  token: hashedToken,
  type: 'magiclink',
})
if (verifyResult.error) {
  console.error('verifyOtp failed:', verifyResult.error)
  process.exit(1)
}
const session = verifyResult.data.session
if (!session?.access_token) {
  console.error('no access_token in session:', verifyResult.data)
  process.exit(1)
}

console.log('USER_ID=' + session.user.id)
console.log('ACCESS_TOKEN=' + session.access_token)
console.log('EXPIRES_AT=' + session.expires_at)
