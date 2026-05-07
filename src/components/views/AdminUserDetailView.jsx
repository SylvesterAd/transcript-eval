import { useParams, Link } from 'react-router-dom'
import { useApi } from '../../hooks/useApi.js'
import { ArrowLeft, ExternalLink, Folder, Mail, CalendarClock, Clock } from 'lucide-react'

function formatDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function projectStatusLabel(p) {
  // Roughly mirrors aggregateProgress() in ProjectsView.jsx but reduced
  // to a single label suitable for a one-line row.
  if (p.broll_chain_status === 'done') return 'Done'
  if (p.broll_chain_status === 'failed') return 'Failed'
  if (p.broll_chain_status === 'running' || p.broll_chain_status === 'pending') return 'Running'
  if (p.broll_chain_status?.startsWith?.('paused_at_')) return 'Paused'
  if (p.rough_cut_status === 'done') return 'Rough cut ready'
  if (p.rough_cut_status === 'running' || p.rough_cut_status === 'pending') return 'Cutting'
  if (p.assembly_status === 'confirmed' || p.assembly_status === 'done') return 'Synced'
  return 'Draft'
}

function statusColor(label) {
  switch (label) {
    case 'Done': return 'bg-emerald-900/40 text-emerald-300 border-emerald-800/60'
    case 'Failed': return 'bg-red-900/40 text-red-300 border-red-800/60'
    case 'Running':
    case 'Cutting': return 'bg-blue-900/40 text-blue-300 border-blue-800/60'
    case 'Paused': return 'bg-amber-900/40 text-amber-300 border-amber-800/60'
    case 'Rough cut ready':
    case 'Synced': return 'bg-zinc-800 text-zinc-300 border-zinc-700'
    default: return 'bg-zinc-900 text-zinc-500 border-zinc-800'
  }
}

export default function AdminUserDetailView() {
  const { userId } = useParams()
  const { data, loading, error } = useApi(`/admin/users/${userId}`, [userId])

  if (loading) return <div className="p-6 text-zinc-400">Loading user…</div>
  if (error) return <div className="p-6 text-red-400">Failed to load user: {error}</div>

  const user = data?.user
  const projects = data?.projects || []
  if (!user) return <div className="p-6 text-zinc-400">User not found.</div>

  const role = user.app_metadata?.role || user.user_metadata?.role || 'user'

  return (
    <div className="p-6 space-y-6">
      <Link
        to="/admin/users"
        className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-200"
      >
        <ArrowLeft size={14} /> Back to users
      </Link>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="flex items-center gap-2 mb-4">
          <Mail size={16} className="text-zinc-500" />
          <h2 className="text-lg font-semibold text-zinc-100">
            {user.email || <span className="italic text-zinc-500">no email</span>}
          </h2>
          {role !== 'user' && (
            <span className="px-1.5 py-0.5 rounded border border-amber-800/60 bg-amber-900/30 text-[10px] uppercase tracking-wider text-amber-300">
              {role}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-1">
              <CalendarClock size={12} /> Joined
            </div>
            <div className="text-zinc-300">{formatDate(user.created_at)}</div>
          </div>
          <div>
            <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-1">
              <Clock size={12} /> Last sign-in
            </div>
            <div className="text-zinc-300">{formatDate(user.last_sign_in_at)}</div>
          </div>
          <div className="col-span-2">
            <div className="text-xs text-zinc-500 mb-1">User ID</div>
            <div className="font-mono text-xs text-zinc-400">{user.id}</div>
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-3">
          <Folder size={16} className="text-zinc-400" />
          <h3 className="text-sm font-medium text-zinc-300">
            Projects <span className="text-zinc-500">({projects.length})</span>
          </h3>
        </div>

        {projects.length === 0 ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-6 text-center text-sm text-zinc-500">
            No projects.
          </div>
        ) : (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900 text-xs uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Project</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-left font-medium">Created</th>
                  <th className="px-4 py-2 w-24"></th>
                </tr>
              </thead>
              <tbody>
                {projects.map(p => {
                  const label = projectStatusLabel(p)
                  return (
                    <tr key={p.id} className="border-t border-zinc-800 hover:bg-zinc-900/60 transition-colors">
                      <td className="px-4 py-2.5">
                        <div className="text-zinc-200">{p.name || <span className="italic text-zinc-500">untitled</span>}</div>
                        <div className="text-[10px] text-zinc-600 font-mono mt-0.5">id: {p.id}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-block px-2 py-0.5 text-[11px] rounded border ${statusColor(label)}`}>
                          {label}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-zinc-400">{formatDate(p.created_at)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <Link
                          to={`/editor/${p.id}?inspectUser=${user.id}`}
                          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-300 hover:text-white hover:bg-zinc-800"
                        >
                          Open <ExternalLink size={12} />
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
