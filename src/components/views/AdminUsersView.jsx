import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi, apiPost } from '../../hooks/useApi.js'
import { ChevronRight, Users, LogIn } from 'lucide-react'

function formatDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    })
  } catch {
    return iso
  }
}

function formatRelative(iso) {
  if (!iso) return 'Never'
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return iso
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

// Mints a one-time Supabase magiclink via the backend and navigates the
// browser to it. Following the link replaces the current Supabase session
// with one for `userId` — the admin must sign out and back in to return
// to their own account.
async function impersonate(userId, email, setBusyId) {
  const ok = window.confirm(
    `You'll be signed in as ${email}.\n\n` +
    `Your admin session will end. To return, sign out and sign back in with your admin email.`,
  )
  if (!ok) return
  setBusyId(userId)
  try {
    const { action_link } = await apiPost(`/admin/users/${userId}/impersonate`, {
      redirect_to: `${window.location.origin}/`,
    })
    window.location.href = action_link
  } catch (err) {
    setBusyId(null)
    window.alert(`Impersonation failed: ${err.message}`)
  }
}

export default function AdminUsersView() {
  const [page, setPage] = useState(1)
  const perPage = 50
  const [busyId, setBusyId] = useState(null)
  const { data, loading, error } = useApi(`/admin/users?page=${page}&perPage=${perPage}`, [page])

  if (loading) return <div className="p-6 text-zinc-400">Loading users…</div>
  if (error) {
    return (
      <div className="p-6 space-y-2">
        <div className="text-red-400">Failed to load users: {error}</div>
        {error.includes('503') && (
          <div className="text-sm text-zinc-500">
            Set <code className="text-zinc-400">SUPABASE_SERVICE_ROLE_KEY</code> in the server env to enable.
          </div>
        )}
      </div>
    )
  }

  const users = data?.users || []
  const total = data?.total

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Users size={20} className="text-zinc-400" />
        <h2 className="text-xl font-semibold">Users</h2>
        {typeof total === 'number' && (
          <span className="text-sm text-zinc-500">{total} total</span>
        )}
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Email</th>
              <th className="px-4 py-2 text-right font-medium">Projects</th>
              <th className="px-4 py-2 text-left font-medium">Last sign-in</th>
              <th className="px-4 py-2 text-left font-medium">Joined</th>
              <th className="px-4 py-2 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-zinc-500">No users on this page.</td>
              </tr>
            )}
            {users.map(u => (
              <tr
                key={u.id}
                className="border-t border-zinc-800 hover:bg-zinc-900/60 transition-colors"
              >
                <td className="px-4 py-2.5">
                  <Link to={`/admin/users/${u.id}`} className="text-zinc-200 hover:text-white">
                    {u.email || <span className="text-zinc-500 italic">no email</span>}
                  </Link>
                  <div className="text-[10px] text-zinc-600 font-mono mt-0.5">{u.id}</div>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {u.project_count > 0 ? (
                    <span className="text-zinc-200">{u.project_count}</span>
                  ) : (
                    <span className="text-zinc-600">0</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-zinc-400">{formatRelative(u.last_sign_in_at)}</td>
                <td className="px-4 py-2.5 text-zinc-400">{formatDate(u.created_at)}</td>
                <td className="px-4 py-2.5 text-right">
                  <div className="inline-flex items-center gap-1">
                    <Link
                      to={`/admin/users/${u.id}`}
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800"
                      title="View profile + project list (no sign-in)"
                    >
                      Profile <ChevronRight size={12} />
                    </Link>
                    <button
                      onClick={() => impersonate(u.id, u.email, setBusyId)}
                      disabled={busyId === u.id || !u.email}
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-amber-300 hover:text-amber-100 hover:bg-amber-900/40 disabled:opacity-40 disabled:cursor-not-allowed"
                      title={u.email ? 'Sign in as this user (replaces your session)' : 'No email — magiclink unavailable'}
                    >
                      <LogIn size={12} /> {busyId === u.id ? 'Signing in…' : 'Inspect'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-zinc-500">
        <button
          onClick={() => setPage(p => Math.max(1, p - 1))}
          disabled={page <= 1}
          className="rounded px-2 py-1 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          ← Previous
        </button>
        <span>Page {page}</span>
        <button
          onClick={() => setPage(p => p + 1)}
          disabled={users.length < perPage}
          className="rounded px-2 py-1 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40 disabled:hover:bg-transparent"
        >
          Next →
        </button>
      </div>
    </div>
  )
}
