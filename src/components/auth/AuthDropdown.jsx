import { useEffect, useMemo, useRef, useState } from 'react'
import { LogIn, LogOut, Shield, UserRound } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useRole } from '../../contexts/RoleContext.jsx'
import AuthDialog from './AuthDialog.jsx'

function getInitials(label) {
  const clean = (label || '').trim()
  if (!clean) return 'G'

  const parts = clean.split(/\s+/).filter(Boolean)
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase()
  return clean.slice(0, 2).toUpperCase()
}

export default function AuthDropdown({ panel = 'user' }) {
  const navigate = useNavigate()
  const {
    authEnabled,
    isAuthenticated,
    loading,
    role,
    signOut,
    user,
    userDisplayName,
  } = useRole()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [authDialogOpen, setAuthDialogOpen] = useState(false)
  const [signOutError, setSignOutError] = useState('')
  const dropdownRef = useRef(null)

  useEffect(() => {
    const handleClick = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setDropdownOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  useEffect(() => {
    if (!isAuthenticated) setSignOutError('')
  }, [isAuthenticated])

  const displayLabel = userDisplayName || user?.email || 'Guest'
  const initials = useMemo(() => getInitials(displayLabel), [displayLabel])
  const roleLabel = loading ? 'Loading...' : isAuthenticated ? role : 'guest'

  async function handleSignOut() {
    try {
      await signOut()
      setDropdownOpen(false)
      if (panel === 'admin') navigate('/')
    } catch (err) {
      setSignOutError(err.message || 'Unable to sign out')
    }
  }

  function openAuthDialog() {
    setDropdownOpen(false)
    setAuthDialogOpen(true)
  }

  function closeAuthDialog() {
    setAuthDialogOpen(false)
  }

  function openOtherPanel() {
    setDropdownOpen(false)
    navigate(panel === 'admin' ? '/' : '/admin')
  }

  return (
    <>
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setDropdownOpen((value) => !value)}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-lime-500 text-sm font-semibold text-black transition-opacity hover:opacity-90"
        >
          {initials}
        </button>

        {dropdownOpen && (
          <div className="absolute right-0 top-10 z-50 w-64 rounded-xl border border-zinc-800 bg-zinc-900 py-2 text-left shadow-lg">
            <div className="border-b border-zinc-800 px-3 py-2">
              <div className="text-sm font-medium text-zinc-100">{displayLabel}</div>
              <div className="mt-1 text-xs uppercase tracking-[0.18em] text-zinc-500">
                {roleLabel}
              </div>
            </div>

            {signOutError && (
              <div className="mx-3 mt-3 rounded-lg border border-rose-700/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                {signOutError}
              </div>
            )}

            {panel === 'user' && role === 'admin' && (
              <button
                onClick={openOtherPanel}
                className="mt-2 flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
              >
                <Shield size={14} />
                Open Admin Panel
              </button>
            )}

            {panel === 'admin' && (
              <button
                onClick={openOtherPanel}
                className="mt-2 flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
              >
                <UserRound size={14} />
                Open User Panel
              </button>
            )}

            {!isAuthenticated && (
              <button
                onClick={openAuthDialog}
                disabled={!authEnabled}
                className="mt-2 flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-500 disabled:hover:bg-transparent"
              >
                <LogIn size={14} />
                Sign In or Sign Up
              </button>
            )}

            {isAuthenticated && (
              <button
                onClick={handleSignOut}
                className="mt-2 flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-200 transition-colors hover:bg-zinc-800"
              >
                <LogOut size={14} />
                Sign Out
              </button>
            )}
          </div>
        )}
      </div>

      <AuthDialog open={authDialogOpen} onClose={closeAuthDialog} />
    </>
  )
}
