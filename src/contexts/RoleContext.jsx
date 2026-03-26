import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
} from 'react'
import { hasSupabaseAuthConfig, supabase } from '../lib/supabaseClient.js'

const RoleContext = createContext()

const ADMIN_EMAILS = ['silvestras.stonk@gmail.com']

function getRoleFromUser(user) {
  if (user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase())) return 'admin'
  return user?.app_metadata?.role || user?.user_metadata?.role || 'user'
}

function getDisplayName(user) {
  const fullName = user?.user_metadata?.full_name || user?.user_metadata?.name
  if (fullName) return fullName
  if (user?.email) return user.email
  return 'Guest'
}

export function RoleProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(hasSupabaseAuthConfig)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!hasSupabaseAuthConfig || !supabase) {
      setLoading(false)
      return undefined
    }

    let active = true

    supabase.auth.getSession()
      .then(({ data, error: sessionError }) => {
        if (!active) return
        if (sessionError) setError(sessionError.message)
        setSession(data.session ?? null)
        setLoading(false)
      })
      .catch((err) => {
        if (!active) return
        setError(err.message || 'Unable to restore session')
        setLoading(false)
      })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return
      setSession(nextSession ?? null)
      setLoading(false)
      setError(null)
    })

    return () => {
      active = false
      listener.subscription.unsubscribe()
    }
  }, [])

  const signInWithPassword = useCallback(async ({ email, password }) => {
    if (!supabase) throw new Error('Supabase auth is not configured yet.')

    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (signInError) throw signInError
    return data
  }, [])

  const signUp = useCallback(async ({ email, password }) => {
    if (!supabase) throw new Error('Supabase auth is not configured yet.')

    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
    })

    if (signUpError) throw signUpError
    return data
  }, [])

  const signOut = useCallback(async () => {
    if (!supabase) return
    const { error: signOutError } = await supabase.auth.signOut()
    if (signOutError) throw signOutError
  }, [])

  const value = useMemo(() => {
    const user = session?.user ?? null
    const role = getRoleFromUser(user)

    return {
      authEnabled: hasSupabaseAuthConfig,
      error,
      isAdmin: role === 'admin',
      isAuthenticated: Boolean(user),
      loading,
      role,
      session,
      signInWithPassword,
      signOut,
      signUp,
      user,
      userDisplayName: getDisplayName(user),
    }
  }, [error, loading, session, signInWithPassword, signOut, signUp])

  return (
    <RoleContext.Provider value={value}>
      {children}
    </RoleContext.Provider>
  )
}

export function useRole() {
  const ctx = useContext(RoleContext)
  if (!ctx) throw new Error('useRole must be used within RoleProvider')
  return ctx
}
