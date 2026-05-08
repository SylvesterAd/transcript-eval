// server/routes/__tests__/editor-state-cut-edit.test.js
//
// Real-DB integration tests for the cut-edit handler in
// PUT /groups/:id/editor-state.
//
// The legacy recomputePlacementsForCuts path has been removed from
// _putEditorStateHandler (Task 7). Modern remap runs inside getBRollEditorData
// via cutsHash diff. This file verifies:
//   - cut change → placements are NOT mutated (modern remap is elsewhere)
//   - cuts unchanged → route is a passthrough (preserves caller-set times)
//
// Uses real Postgres because the route reads/writes editor_state_json from
// the same DB. Pattern: direct handler invocation with real DB. Supertest is
// not a project dependency, so we call _putEditorStateHandler directly.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import db from '../../db.js'
import { _putEditorStateHandler } from '../videos.js'

function makeRes() {
  return {
    status(c) { this._status = c; return this },
    json(b) { this._body = b; return this },
  }
}

describe('PUT /editor-state cut-edit handler', () => {
  let groupId, videoId

  beforeAll(async () => {
    const v = await db.prepare("INSERT INTO videos (title, video_type) VALUES ('test-cut-edit', 'raw') RETURNING id").get()
    videoId = v.id
    const words = [
      { word: 'a', start: 0, end: 1 },
      { word: 'b', start: 1, end: 2 },
      { word: 'c', start: 5, end: 6 },
      { word: 'd', start: 10, end: 11 },
    ]
    // transcripts.content is NOT NULL — supply a placeholder string.
    await db.prepare(
      "INSERT INTO transcripts (video_id, type, content, word_timestamps_json) VALUES (?, 'raw', ?, ?)"
    ).run(videoId, 'a b c d', JSON.stringify(words))
    const initial = {
      cuts: [],
      cutExclusions: [],
      broll: {
        placements: [{
          uuid: 'p1',
          anchor_word_idx: 2,
          audio_anchor: 'c',
          start_seconds: 5,
          end_seconds: 8,
        }],
      },
    }
    const g = await db.prepare("INSERT INTO video_groups (name, editor_state_json) VALUES ('cut-edit-test', ?) RETURNING id").get(JSON.stringify(initial))
    groupId = g.id
    await db.prepare('UPDATE videos SET group_id = ? WHERE id = ?').run(groupId, videoId)
  })

  afterAll(async () => {
    // Delete in FK-safe order: transcripts → videos → video_groups.
    // videos.group_id has a FK to video_groups, so we must drop the
    // referring rows before the parent group.
    if (videoId) {
      await db.prepare('DELETE FROM transcripts WHERE video_id = ?').run(videoId)
      await db.prepare('DELETE FROM videos WHERE id = ?').run(videoId)
    }
    if (groupId) await db.prepare('DELETE FROM video_groups WHERE id = ?').run(groupId)
  })

  function makeReq(editor_state) {
    // Auth is the admin branch — isAdmin(req) is true for the seeded email,
    // which short-circuits the user_id ownership filter so seeded fixtures
    // owned by no user_id still match.
    return {
      params: { id: String(groupId) },
      auth: { userId: 'dev', email: 'silvestras.stonk@gmail.com', role: 'admin' },
      body: { editor_state },
    }
  }

  it('does not mutate editor_state.broll.placements when cuts change (modern remap is in getBRollEditorData)', async () => {
    const editor_state = {
      cuts: [{ start: 2, end: 4, source: 'manual' }],  // 2s cut before anchor word at orig t=5
      cutExclusions: [],
      broll: {
        placements: [{
          uuid: 'p1',
          anchor_word_idx: 2,
          audio_anchor: 'c',
          start_seconds: 5,
          end_seconds: 8,
        }],
      },
    }
    const res = makeRes()
    await _putEditorStateHandler(makeReq(editor_state), res)
    expect(res._body).toEqual({ ok: true })
    const row = await db.prepare('SELECT editor_state_json FROM video_groups WHERE id = ?').get(groupId)
    const stored = JSON.parse(row.editor_state_json)
    // Placements must be stored exactly as sent — no legacy recompute in the save path.
    expect(stored.broll.placements[0].start_seconds).toBe(5)
    expect(stored.broll.placements[0].end_seconds).toBe(8)
  })

  it('does not recompute when cuts unchanged', async () => {
    // Use the exact same cuts as set in the previous test (already in DB).
    const editor_state = {
      cuts: [{ start: 2, end: 4, source: 'manual' }],
      cutExclusions: [],
      broll: {
        placements: [{
          uuid: 'p1',
          anchor_word_idx: 2,
          audio_anchor: 'c',
          // Manually set times that would NOT match recompute output if it were to fire.
          start_seconds: 99,
          end_seconds: 102,
        }],
      },
    }
    const res = makeRes()
    await _putEditorStateHandler(makeReq(editor_state), res)
    expect(res._body).toEqual({ ok: true })
    const row = await db.prepare('SELECT editor_state_json FROM video_groups WHERE id = ?').get(groupId)
    const stored = JSON.parse(row.editor_state_json)
    // Times preserved as-sent because cuts didn't change
    expect(stored.broll.placements[0].start_seconds).toBe(99)
    expect(stored.broll.placements[0].end_seconds).toBe(102)
  })

  it('stores placements as-sent even when cuts change and anchor_word_idx is absent', async () => {
    // No legacy recompute means placements with missing anchor_word_idx are no longer flagged
    // orphan at save-time — they are stored verbatim; orphan detection is the concern of the
    // read path (getBRollEditorData).
    const editor_state = {
      cuts: [{ start: 7, end: 9, source: 'manual' }],  // different cut from DB state
      cutExclusions: [],
      broll: {
        placements: [{
          uuid: 'p2',
          // no anchor_word_idx
          audio_anchor: 'unknown',
          start_seconds: 10,
          end_seconds: 13,
        }],
      },
    }
    const res = makeRes()
    await _putEditorStateHandler(makeReq(editor_state), res)
    expect(res._body).toEqual({ ok: true })
    const row = await db.prepare('SELECT editor_state_json FROM video_groups WHERE id = ?').get(groupId)
    const stored = JSON.parse(row.editor_state_json)
    // Stored verbatim — no orphan flag injected by the save handler.
    expect(stored.broll.placements[0].start_seconds).toBe(10)
    expect(stored.broll.placements[0].end_seconds).toBe(13)
    expect(stored.broll.placements[0].anchor_orphaned).toBeUndefined()
  })
})
