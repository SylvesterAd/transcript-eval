import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = {
  parentRow: null,         // SELECT parent_group_id FROM video_groups WHERE id = ?
  sources: [],             // joined sources rows
  videosById: {},          // SELECT id, title, file_path, cf_stream_uid FROM videos WHERE id = ?
}

vi.mock('../../db.js', () => ({
  default: {
    prepare(sql) {
      return {
        async get(...args) {
          if (/SELECT parent_group_id FROM video_groups WHERE id/.test(sql)) return state.parentRow
          if (/SELECT id, title, file_path, cf_stream_uid FROM videos WHERE id/.test(sql)) return state.videosById[args[0]] || null
          return null
        },
        async all(...args) {
          if (/FROM broll_example_sources es[\s\S]*JOIN broll_example_sets/.test(sql)) return state.sources
          return []
        },
        async run(...args) {
          return { changes: 0 }
        },
      }
    },
  },
}))

const { loadExampleVideos } = await import('../broll.js')

beforeEach(() => {
  state.parentRow = null
  state.sources = []
  state.videosById = {}
})

describe('loadExampleVideos', () => {
  it('dedupes when parent + child both contain a source for the same videoId', async () => {
    state.parentRow = { parent_group_id: 253 }
    state.sources = [
      { id: 76, source_url: 'a', kind: 'yt_video', meta_json: JSON.stringify({ videoId: 388 }), is_favorite: 0 },
      { id: 77, source_url: 'b', kind: 'yt_video', meta_json: JSON.stringify({ videoId: 400 }), is_favorite: 1 },
      { id: 78, source_url: 'a', kind: 'yt_video', meta_json: JSON.stringify({ videoId: 388 }), is_favorite: 0 }, // dup of 76
      { id: 79, source_url: 'b', kind: 'yt_video', meta_json: JSON.stringify({ videoId: 400 }), is_favorite: 1 }, // dup of 77
    ]
    state.videosById = {
      388: { id: 388, title: 'You Can\'t Just Write It Off', file_path: '/p/388.mp4', cf_stream_uid: null },
      400: { id: 400, title: 'Placing Your Kids on Payroll', file_path: '/p/400.mp4', cf_stream_uid: null },
    }

    const videos = await loadExampleVideos(254)

    expect(videos).toHaveLength(2)
    expect(videos.map(v => v.id).sort()).toEqual([388, 400])
    // Favorite flag should be preserved (the dedup must not lose isFavorite=true)
    expect(videos.find(v => v.id === 400)?.isFavorite).toBe(true)
  })

  it('returns the single video when no duplication exists', async () => {
    state.parentRow = null
    state.sources = [
      { id: 99, source_url: 'x', kind: 'yt_video', meta_json: JSON.stringify({ videoId: 500 }), is_favorite: 0 },
    ]
    state.videosById = { 500: { id: 500, title: 'Solo', file_path: '/p/500.mp4', cf_stream_uid: null } }

    const videos = await loadExampleVideos(254)
    expect(videos).toHaveLength(1)
    expect(videos[0].id).toBe(500)
  })
})
