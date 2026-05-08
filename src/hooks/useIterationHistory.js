import { useCallback, useState } from 'react'
import { apiGet } from './useApi.js'

export function useIterationHistory(renderId) {
  const [iterations, setIterations] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!renderId) return
    if (iterations !== null) return // already loaded
    setLoading(true)
    setError(null)
    try {
      const data = await apiGet(`/graphics/renders/${renderId}/iterations`)
      setIterations(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [renderId, iterations])

  return { iterations, loading, error, load }
}
