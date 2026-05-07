import { describe, it, expect } from 'vitest'
import { DEFAULT_STATE } from '../UploadConfigFlow.jsx'

describe('UploadConfigFlow DEFAULT_STATE', () => {
  it('defaults pathId to hands-off (Auto + Rough Cut is the primary selection)', () => {
    expect(DEFAULT_STATE.pathId).toBe('hands-off')
  })

  it('defaults autoRoughCut to true', () => {
    expect(DEFAULT_STATE.autoRoughCut).toBe(true)
  })
})
