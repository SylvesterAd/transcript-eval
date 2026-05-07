// src/components/editor/InspectingBanner.jsx
//
// Renders a small "Inspecting <email>" banner across the top of the
// editor when the signed-in admin has opened a project owned by a
// different user. Returns null in every other case (own project,
// non-admin, group not yet loaded) so the banner is safe to drop into
// EditorView's main return unconditionally.
//
// Data sources:
//   - useRole()                              → current user, isAdmin
//   - useApi('/videos/groups/:id/detail')    → group.user_id
//
// The /detail call is the same one EditorView already fires; useApi's
// in-flight coalescing (see hooks/useApi.js) merges them into a single
// network round-trip on the first render. Subsequent refetches from
// EditorView don't propagate here — that's fine, the banner only cares
// about the owner id, which doesn't change.
//
// Wiring:
//   import InspectingBanner from './InspectingBanner.jsx'
//   ...
//   return (
//     <EditorContext.Provider ...>
//       <div className="h-screen flex flex-col ...">
//         <InspectingBanner />
//         <header ...>...</header>
//         ...

import { useParams, Link } from 'react-router-dom'
import { useApi } from '../../hooks/useApi.js'
import { useRole } from '../../contexts/RoleContext.jsx'
import { Eye, ArrowLeft } from 'lucide-react'

export default function InspectingBanner() {
  const { id } = useParams()
  const { user, isAdmin } = useRole()
  const { data: group } = useApi(id ? `/videos/groups/${id}/detail` : null, [id])

  // Decide whether to render BEFORE the second fetch — fetching the
  // owner's profile when the signed-in user is the owner would be
  // wasteful (and the /admin/users endpoint would 403 for non-admins).
  const shouldShow = Boolean(
    isAdmin && group?.user_id && user?.id && group.user_id !== user.id
  )

  // Email lookup. Only fires once shouldShow is true; useApi handles
  // the null path → no fetch.
  const ownerId = shouldShow ? group.user_id : null
  const { data: ownerData } = useApi(ownerId ? `/admin/users/${ownerId}` : null, [ownerId])

  if (!shouldShow) return null

  const ownerEmail = ownerData?.user?.email || null

  return (
    <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2 bg-amber-900/50 border-b border-amber-800 text-amber-100 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        <Eye size={14} className="shrink-0 text-amber-300" />
        <span className="font-medium uppercase tracking-wider text-[10px] text-amber-300">
          Inspecting
        </span>
        <span className="font-medium text-amber-100 truncate">
          {ownerEmail || ownerId}
        </span>
        <span className="text-amber-300/80 hidden md:inline">
          — actions you take are recorded under your admin account.
        </span>
      </div>
      <Link
        to={`/admin/users/${ownerId}`}
        className="shrink-0 inline-flex items-center gap-1 rounded px-2 py-0.5 hover:bg-amber-800/60 text-amber-100"
      >
        <ArrowLeft size={12} /> Back to user
      </Link>
    </div>
  )
}
