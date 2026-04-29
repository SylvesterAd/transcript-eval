import { describe, it, expect } from 'vitest'
import { resolveProjectRoute } from '../projectRoute.js'

// Fresh project: pre-upload (assembly_status null). Config-incomplete
// branches only fire in this state.
const FRESH = {
  id: 1,
  libraries: ['envato'],
  audience: { age: ['millennial'] },
  path_id: 'hands-off',
  auto_rough_cut: false,
  assembly_status: null,
  rough_cut_status: null,
  broll_chain_status: null,
}

// Ready project: post-upload, fully assembled, no chains in flight.
const READY = { ...FRESH, assembly_status: 'done' }

describe('resolveProjectRoute', () => {
  describe('config not finished (pre-upload)', () => {
    it('routes to libraries when libraries empty', () => {
      expect(resolveProjectRoute({ ...FRESH, id: 7, libraries: [] }))
        .toBe('/?step=libraries&group=7')
    })

    it('routes to audience when audience null', () => {
      expect(resolveProjectRoute({ ...FRESH, id: 7, audience: null }))
        .toBe('/?step=audience&group=7')
    })

    it('routes to path when path_id null even if everything else set', () => {
      expect(resolveProjectRoute({ ...FRESH, id: 7, path_id: null }))
        .toBe('/?step=path&group=7')
    })

    it('routes to processing when fresh project has all config but no assembly yet', () => {
      expect(resolveProjectRoute({ ...FRESH, id: 7 }))
        .toBe('/?step=processing&group=7')
    })
  })

  describe('post-upload — config columns ignored even if NULL', () => {
    // Legacy projects created before audience/path columns existed have
    // null audience_json + path_id but assembly_status='confirmed'/'done'.
    // They must NOT be redirected back into the config flow.
    it('routes to editor when assembly done despite null audience', () => {
      expect(resolveProjectRoute({
        ...READY, id: 224, audience: null, path_id: null,
      })).toBe('/editor/224/assets')
    })

    it('routes to editor when assembly confirmed despite null path_id', () => {
      expect(resolveProjectRoute({
        ...READY, id: 224, assembly_status: 'confirmed', path_id: null,
      })).toBe('/editor/224/assets')
    })

    it('routes to processing when assembly classifying despite null audience', () => {
      expect(resolveProjectRoute({
        ...READY, id: 224, assembly_status: 'classifying', audience: null,
      })).toBe('/?step=processing&group=224')
    })
  })

  describe('still processing', () => {
    it('routes to processing when assembly_status is classified', () => {
      expect(resolveProjectRoute({ ...READY, id: 7, assembly_status: 'classified' }))
        .toBe('/?step=processing&group=7')
    })

    it('routes to processing when assembly_status is transcribing', () => {
      expect(resolveProjectRoute({ ...READY, id: 7, assembly_status: 'transcribing' }))
        .toBe('/?step=processing&group=7')
    })

    it('routes to processing when rough_cut_status is pending', () => {
      expect(resolveProjectRoute({ ...READY, id: 7, rough_cut_status: 'pending' }))
        .toBe('/?step=processing&group=7')
    })

    it('routes to processing when broll_chain_status is running', () => {
      expect(resolveProjectRoute({ ...READY, id: 7, broll_chain_status: 'running' }))
        .toBe('/?step=processing&group=7')
    })
  })

  describe('ready for editor', () => {
    it('routes to editor when assembly done + chains idle/done/null', () => {
      expect(resolveProjectRoute({ ...READY, id: 42 }))
        .toBe('/editor/42/assets')
    })

    it('routes to editor when assembly confirmed + chains done', () => {
      expect(resolveProjectRoute({
        ...READY, id: 42, assembly_status: 'confirmed', rough_cut_status: 'done',
      })).toBe('/editor/42/assets')
    })

    it('routes to editor when broll_chain_status is done', () => {
      expect(resolveProjectRoute({ ...READY, id: 42, broll_chain_status: 'done' }))
        .toBe('/editor/42/assets')
    })
  })
})
