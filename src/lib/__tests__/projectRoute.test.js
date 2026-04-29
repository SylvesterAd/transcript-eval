import { describe, it, expect } from 'vitest'
import { resolveProjectRoute } from '../projectRoute.js'

const READY = {
  id: 1,
  libraries: ['envato'],
  audience: { age: ['millennial'] },
  path_id: 'hands-off',
  auto_rough_cut: false,
  assembly_status: 'done',
  rough_cut_status: null,
  broll_chain_status: null,
}

describe('resolveProjectRoute', () => {
  describe('config not finished', () => {
    it('routes to libraries when libraries empty', () => {
      expect(resolveProjectRoute({ ...READY, id: 7, libraries: [] }))
        .toBe('/?step=libraries&group=7')
    })

    it('routes to audience when audience null', () => {
      expect(resolveProjectRoute({ ...READY, id: 7, audience: null }))
        .toBe('/?step=audience&group=7')
    })

    it('routes to path when path_id null even if everything else set', () => {
      expect(resolveProjectRoute({ ...READY, id: 7, path_id: null }))
        .toBe('/?step=path&group=7')
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

    it('routes to editor when rough_cut_status is done', () => {
      expect(resolveProjectRoute({ ...READY, id: 42, rough_cut_status: 'done' }))
        .toBe('/editor/42/assets')
    })

    it('routes to editor when broll_chain_status is done', () => {
      expect(resolveProjectRoute({ ...READY, id: 42, broll_chain_status: 'done' }))
        .toBe('/editor/42/assets')
    })
  })

  describe('priority ordering', () => {
    it('prefers config-incomplete over still-processing', () => {
      expect(resolveProjectRoute({
        ...READY, id: 7, path_id: null, assembly_status: 'transcribing',
      })).toBe('/?step=path&group=7')
    })

    it('prefers still-processing over editor', () => {
      expect(resolveProjectRoute({
        ...READY, id: 7, assembly_status: 'classified',
      })).toBe('/?step=processing&group=7')
    })
  })
})
