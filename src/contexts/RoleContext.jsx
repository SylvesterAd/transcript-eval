import { createContext, useContext, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'

const RoleContext = createContext()

export function RoleProvider({ children }) {
  const [role, setRoleState] = useState(
    () => localStorage.getItem('app-role') || 'user'
  )

  const setRole = useCallback((newRole) => {
    localStorage.setItem('app-role', newRole)
    setRoleState(newRole)
  }, [])

  return (
    <RoleContext.Provider value={{ role, setRole, isAdmin: role === 'admin' }}>
      {children}
    </RoleContext.Provider>
  )
}

export function useRole() {
  const ctx = useContext(RoleContext)
  if (!ctx) throw new Error('useRole must be used within RoleProvider')
  return ctx
}
