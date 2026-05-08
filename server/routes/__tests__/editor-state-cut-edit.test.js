// server/routes/__tests__/editor-state-cut-edit.test.js
//
// Real-DB integration tests for the cut-edit handler in
// PUT /groups/:id/editor-state.
//
// When the user edits cuts (drag handle, add/delete cut) in the editor and
// saves, every placement's post-cut start_seconds/end_seconds must shift
// accordingly so the timeline stays consistent. This file verifies:
//   - cut change → recompute fires, anchor_word_idx drives new times
//   - cuts unchanged → route is a passthrough (preserves caller-set times)
//   - missing/invalid anchor_word_idx → placement flagged orphan, not recomputed
//
// Uses real Postgres because the route reads transcripts.word_timestamps_json
// from the same DB it writes editor_state_json into; mocking that surface
// would defeat the purpose of integration coverage. All fixtures live under
// the seeded video_groups.id and are torn down in afterAll.
//
// Pattern: direct handler invocation with real DB. Mirrors
// videos-register-duration.test.js (mock req/res shape) and
// broll-placement-uuid.test.js (real-DB fixture lifecycle). Supertest is
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

  it('recomputes placement post-cut times when cuts change', async () => {
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
    // Original word 'c' at t=5. Cut [2,4] removes 2s. Post-cut t = 3. Duration 3 preserved.
    expect(stored.broll.placements[0].start_seconds).toBe(3)
    expect(stored.broll.placements[0].end_seconds).toBe(6)
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

  it('handles missing word_timestamps gracefully (no recompute attempt)', async () => {
    // Test with a placement that has no anchor_word_idx — should be flagged orphan.
    const editor_state = {
      cuts: [{ start: 7, end: 9, source: 'manual' }],  // different cut to trigger recompute
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
    expect(stored.broll.placements[0].anchor_orphaned).toBe(true)
  })
})
