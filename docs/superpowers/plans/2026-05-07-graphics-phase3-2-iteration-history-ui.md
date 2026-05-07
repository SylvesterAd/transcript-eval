# Motion Graphics — Phase 3.2: Iteration History UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an expandable "iteration history" panel to `RenderViewer` that shows all critic-loop attempts side-by-side — frame thumbnails, score, criteria breakdown, and feedback for each iteration.

**Architecture:** New backend endpoint `GET /api/graphics/renders/:id/iterations` returning rows from `graphics_render_iterations`. New frontend `IterationHistoryPanel` component with lazy fetch on expand, integrated into `RenderViewer` via a toggle button. No changes to the critic-loop pipeline — Phase 2 already writes everything we need to the table.

**Tech Stack:** React + Tailwind (existing motion-graphics conventions), Node/Express (existing graphics route patterns), vitest + @testing-library/react.

**Out of scope:** Critic re-run from history, per-iteration MP4 playback (server stores `mp4_path` as a local-only path), per-frame zoom/lightbox. Reserved if user asks.

---

## File Structure

**Modified:**
- `server/routes/graphics.js` — add iterations route handler
- `server/routes/__tests__/graphics.test.js` — add tests for iterations route
- `src/components/motion-graphics/RenderViewer.jsx` — add toggle + integrate panel
- `src/components/motion-graphics/__tests__/RenderViewer.test.jsx` — assert toggle visibility

**Created:**
- `src/hooks/useIterationHistory.js` — lazy-fetch hook
- `src/hooks/__tests__/useIterationHistory.test.jsx` — hook tests
- `src/components/motion-graphics/IterationHistoryPanel.jsx` — panel component
- `src/components/motion-graphics/__tests__/IterationHistoryPanel.test.jsx` — component tests

**Untouched (verified before each task):**
- `server/services/graphics/critic/critic-runner.js` — already inserts into `graphics_render_iterations`
- `server/services/graphics/render-worker.js` — already updates `iteration_count` + `final_score` on parent
- `server/db.js` — table migration already in place from Phase 2
- `server/services/graphics/uploader.js` — frame URLs are already public Supabase paths

---

### Task 1: Backend `GET /api/graphics/renders/:id/iterations` endpoint

**Files:**
- Modify: `server/routes/graphics.js`
- Modify: `server/routes/__tests__/graphics.test.js`

The endpoint returns iteration rows for a render owned by the auth'd user, ordered by `iteration_index ASC`. Auth: same admin-only middleware already applied at the router level. Ownership: verified via JOIN to `graphics_sessions` (matches the existing `GET /renders/:id` pattern).

**Response shape:**
```json
[
  {
    "id": 12,
    "render_id": 5,
    "iteration_index": 0,
    "frame_urls": ["https://supa/.../f0.png", "..."],
    "critic_score": 0.45,
    "critic_criteria": {"fidelity":0.5,"legibility":0.6,"style":0.4,"timing":0.3},
    "critic_feedback": "...",
    "created_at": "2026-05-07T12:00:00Z"
  }
]
```

Note: server returns `frame_urls` (parsed) and `critic_criteria` (parsed) for direct UI consumption. `mp4_path` is intentionally NOT returned (it's a local server path, not a public URL).

- [ ] **Step 1: Write the failing tests**

Append the following describe block to `server/routes/__tests__/graphics.test.js` (after the existing `describe('POST /sessions', ...)` block, before the closing of the file):

```js
describe('GET /renders/:id/iterations', () => {
  beforeEach(() => {
    nextRow = null;
    nextRows = [];
  });

  it('admin owner: 200 + iteration array (sorted)', async () => {
    nextRow = { id: 5 }; // ownership row
    nextRows = [
      {
        id: 11,
        render_id: 5,
        iteration_index: 0,
        frame_urls_json: ['u0a', 'u0b', 'u0c', 'u0d'],
        critic_score: 0.45,
        critic_criteria_json: { fidelity: 0.5, legibility: 0.6, style: 0.4, timing: 0.3 },
        critic_feedback: 'too dim',
        created_at: '2026-05-07T12:00:00Z',
      },
      {
        id: 12,
        render_id: 5,
        iteration_index: 1,
        frame_urls_json: ['u1a', 'u1b', 'u1c', 'u1d'],
        critic_score: 0.85,
        critic_criteria_json: { fidelity: 0.9, legibility: 0.85, style: 0.8, timing: 0.85 },
        critic_feedback: 'looks good',
        created_at: '2026-05-07T12:01:00Z',
      },
    ];
    const handlers = extractHandlers('/renders/:id/iterations', 'get');
    const req = {
      auth: { userId: 'user-1', email: 'admin@test', isAdminFlag: true },
      params: { id: '5' },
    };
    const res = makeRes();
    await runChain(handlers, req, res);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].iteration_index).toBe(0);
    expect(res.body[0].frame_urls).toEqual(['u0a', 'u0b', 'u0c', 'u0d']);
    expect(res.body[0].critic_criteria.fidelity).toBe(0.5);
    expect(res.body[0]).not.toHaveProperty('mp4_path');
    expect(res.body[0]).not.toHaveProperty('frame_urls_json');
    expect(res.body[1].critic_score).toBe(0.85);
  });

  it('not owner / not found: 404', async () => {
    nextRow = null; // no ownership match
    const handlers = extractHandlers('/renders/:id/iterations', 'get');
    const req = {
      auth: { userId: 'user-1', email: 'admin@test', isAdminFlag: true },
      params: { id: '999' },
    };
    const res = makeRes();
    await runChain(handlers, req, res);
    expect(res.statusCode).toBe(404);
  });

  it('non-admin: 403', async () => {
    const handlers = extractHandlers('/renders/:id/iterations', 'get');
    const req = {
      auth: { userId: 'user-2', email: 'rando@test', isAdminFlag: false },
      params: { id: '5' },
    };
    const res = makeRes();
    await runChain(handlers, req, res);
    expect(res.statusCode).toBe(403);
  });

  it('bad id: 400', async () => {
    const handlers = extractHandlers('/renders/:id/iterations', 'get');
    const req = {
      auth: { userId: 'user-1', email: 'admin@test', isAdminFlag: true },
      params: { id: 'abc' },
    };
    const res = makeRes();
    await runChain(handlers, req, res);
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/graphics-iteration-history-ui"
npx vitest run server/routes/__tests__/graphics.test.js
```

Expected: 4 new tests fail (`no get route for /renders/:id/iterations`).

- [ ] **Step 3: Add the route handler**

In `server/routes/graphics.js`, insert this handler immediately after the existing `GET /renders/:id` handler (after line 100, before `export default router;`):

```js
// GET /api/graphics/renders/:id/iterations
router.get('/renders/:id/iterations', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const owner = await db
    .prepare(
      `SELECT r.id FROM graphics_renders r
       JOIN graphics_sessions s ON s.id = r.session_id
       WHERE r.id = ? AND s.user_id = ?`
    )
    .get(id, req.auth.userId);
  if (!owner) return res.status(404).json({ error: 'not found' });
  const rows = await db
    .prepare(
      `SELECT id, render_id, iteration_index, frame_urls_json,
              critic_score, critic_criteria_json, critic_feedback, created_at
       FROM graphics_render_iterations
       WHERE render_id = ?
       ORDER BY iteration_index ASC`
    )
    .all(id);
  res.json(
    rows.map((r) => ({
      id: r.id,
      render_id: r.render_id,
      iteration_index: r.iteration_index,
      frame_urls: typeof r.frame_urls_json === 'string' ? JSON.parse(r.frame_urls_json) : r.frame_urls_json || [],
      critic_score: r.critic_score,
      critic_criteria: typeof r.critic_criteria_json === 'string' ? JSON.parse(r.critic_criteria_json) : r.critic_criteria_json,
      critic_feedback: r.critic_feedback,
      created_at: r.created_at,
    }))
  );
});
```

The `typeof === 'string'` guard handles the difference between PG (returns JSONB as parsed object) and the test mock (returns whatever the test fixture set).

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run server/routes/__tests__/graphics.test.js
```

Expected: all tests in this file pass (existing `POST /sessions` tests + 4 new `GET /renders/:id/iterations` tests).

- [ ] **Step 5: Commit**

```bash
git add server/routes/graphics.js server/routes/__tests__/graphics.test.js
git commit -m "feat(graphics): GET /renders/:id/iterations endpoint"
```

---

### Task 2: `useIterationHistory` lazy-fetch hook

**Files:**
- Create: `src/hooks/useIterationHistory.js`
- Create: `src/hooks/__tests__/useIterationHistory.test.jsx`

The hook starts in idle state. Calling `load()` fetches `/graphics/renders/:id/iterations` once and caches the result. Subsequent calls are no-ops while loaded. Errors surface via `error` state. Loading flag toggles around the fetch.

- [ ] **Step 1: Write the failing tests**

Create `src/hooks/__tests__/useIterationHistory.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const apiGetMock = vi.fn()
vi.mock('../useApi.js', () => ({
  apiGet: (...args) => apiGetMock(...args),
}))

beforeEach(() => {
  apiGetMock.mockReset()
})

const { useIterationHistory } = await import('../useIterationHistory.js')

describe('useIterationHistory', () => {
  it('starts idle (no fetch until load() called)', () => {
    const { result } = renderHook(() => useIterationHistory(42))
    expect(result.current.iterations).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(apiGetMock).not.toHaveBeenCalled()
  })

  it('load() fetches iterations and updates state', async () => {
    apiGetMock.mockResolvedValueOnce([
      { id: 1, iteration_index: 0, frame_urls: [], critic_score: 0.5, critic_criteria: {}, critic_feedback: 'meh' },
    ])
    const { result } = renderHook(() => useIterationHistory(42))
    await act(async () => {
      await result.current.load()
    })
    expect(apiGetMock).toHaveBeenCalledWith('/graphics/renders/42/iterations')
    expect(result.current.iterations).toHaveLength(1)
    expect(result.current.iterations[0].critic_score).toBe(0.5)
    expect(result.current.loading).toBe(false)
  })

  it('load() sets loading true during fetch', async () => {
    let resolveFetch
    apiGetMock.mockImplementationOnce(
      () => new Promise((r) => { resolveFetch = r })
    )
    const { result } = renderHook(() => useIterationHistory(42))
    act(() => { result.current.load() })
    await waitFor(() => expect(result.current.loading).toBe(true))
    await act(async () => {
      resolveFetch([])
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
  })

  it('load() captures errors', async () => {
    apiGetMock.mockRejectedValueOnce(new Error('500 oops'))
    const { result } = renderHook(() => useIterationHistory(42))
    await act(async () => {
      await result.current.load()
    })
    expect(result.current.error).toBe('500 oops')
    expect(result.current.iterations).toBeNull()
  })

  it('second load() is a no-op once loaded', async () => {
    apiGetMock.mockResolvedValueOnce([{ id: 1, iteration_index: 0 }])
    const { result } = renderHook(() => useIterationHistory(42))
    await act(async () => { await result.current.load() })
    await act(async () => { await result.current.load() })
    expect(apiGetMock).toHaveBeenCalledTimes(1)
  })

  it('returns null iterations when renderId is missing (graceful)', () => {
    const { result } = renderHook(() => useIterationHistory(null))
    expect(result.current.iterations).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/hooks/__tests__/useIterationHistory.test.jsx
```

Expected: fails with module-not-found for `../useIterationHistory.js`.

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useIterationHistory.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/hooks/__tests__/useIterationHistory.test.jsx
```

Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useIterationHistory.js src/hooks/__tests__/useIterationHistory.test.jsx
git commit -m "feat(graphics): useIterationHistory lazy-fetch hook"
```

---

### Task 3: `IterationHistoryPanel` component

**Files:**
- Create: `src/components/motion-graphics/IterationHistoryPanel.jsx`
- Create: `src/components/motion-graphics/__tests__/IterationHistoryPanel.test.jsx`

Pure-presentation component: takes `iterations`, `loading`, `error` and renders a horizontal scrollable strip of iteration cards. Each card shows: iteration index, score (with badge style based on score), 4 frame thumbnails, criteria breakdown (4 mini-bars or values), feedback paragraph. The card with the highest score gets a "★ best" marker. Failure modes: loading spinner, error message, empty state.

Layout: `flex gap-3 overflow-x-auto`, each card `min-w-[240px]` so 3 cards fit in ~720px and scroll if narrower.

- [ ] **Step 1: Write the failing tests**

Create `src/components/motion-graphics/__tests__/IterationHistoryPanel.test.jsx`:

```jsx
import { render, screen, cleanup } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { IterationHistoryPanel } from '../IterationHistoryPanel.jsx'

afterEach(cleanup)

const sample = [
  {
    id: 1,
    iteration_index: 0,
    frame_urls: ['https://x/0a.png', 'https://x/0b.png', 'https://x/0c.png', 'https://x/0d.png'],
    critic_score: 0.45,
    critic_criteria: { fidelity: 0.5, legibility: 0.6, style: 0.4, timing: 0.3 },
    critic_feedback: 'frames too dim, text overflows',
  },
  {
    id: 2,
    iteration_index: 1,
    frame_urls: ['https://x/1a.png', 'https://x/1b.png', 'https://x/1c.png', 'https://x/1d.png'],
    critic_score: 0.85,
    critic_criteria: { fidelity: 0.9, legibility: 0.85, style: 0.8, timing: 0.85 },
    critic_feedback: 'looks good',
  },
]

describe('IterationHistoryPanel', () => {
  it('renders one card per iteration', () => {
    render(<IterationHistoryPanel iterations={sample} loading={false} error={null} />)
    expect(screen.getByText(/iteration 0/i)).toBeDefined()
    expect(screen.getByText(/iteration 1/i)).toBeDefined()
  })

  it('shows score for each iteration', () => {
    render(<IterationHistoryPanel iterations={sample} loading={false} error={null} />)
    expect(screen.getByText(/0\.45/)).toBeDefined()
    expect(screen.getByText(/0\.85/)).toBeDefined()
  })

  it('renders 4 frame thumbnails per card', () => {
    const { container } = render(<IterationHistoryPanel iterations={sample} loading={false} error={null} />)
    const imgs = container.querySelectorAll('img')
    expect(imgs.length).toBe(8)
    expect(imgs[0].getAttribute('src')).toBe('https://x/0a.png')
    expect(imgs[4].getAttribute('src')).toBe('https://x/1a.png')
  })

  it('marks best (highest-score) iteration', () => {
    render(<IterationHistoryPanel iterations={sample} loading={false} error={null} />)
    const best = screen.getByText(/best/i)
    expect(best).toBeDefined()
  })

  it('renders feedback paragraph', () => {
    render(<IterationHistoryPanel iterations={sample} loading={false} error={null} />)
    expect(screen.getByText(/frames too dim/i)).toBeDefined()
    expect(screen.getByText(/looks good/i)).toBeDefined()
  })

  it('shows criteria values', () => {
    render(<IterationHistoryPanel iterations={sample} loading={false} error={null} />)
    expect(screen.getByText(/fidelity/i)).toBeDefined()
    expect(screen.getByText(/legibility/i)).toBeDefined()
    expect(screen.getByText(/style/i)).toBeDefined()
    expect(screen.getByText(/timing/i)).toBeDefined()
  })

  it('shows loading state', () => {
    render(<IterationHistoryPanel iterations={null} loading={true} error={null} />)
    expect(screen.getByText(/loading/i)).toBeDefined()
  })

  it('shows error state', () => {
    render(<IterationHistoryPanel iterations={null} loading={false} error="500 oops" />)
    expect(screen.getByText(/500 oops/i)).toBeDefined()
  })

  it('shows empty state when iterations is empty array', () => {
    render(<IterationHistoryPanel iterations={[]} loading={false} error={null} />)
    expect(screen.getByText(/no iterations/i)).toBeDefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/components/motion-graphics/__tests__/IterationHistoryPanel.test.jsx
```

Expected: fails with module-not-found.

- [ ] **Step 3: Implement the component**

Create `src/components/motion-graphics/IterationHistoryPanel.jsx`:

```jsx
function scoreBadgeClass(score) {
  if (score >= 0.8) return 'bg-emerald-900 text-emerald-200'
  if (score >= 0.6) return 'bg-amber-900 text-amber-200'
  return 'bg-red-900 text-red-200'
}

function CriteriaRow({ label, value }) {
  const pct = Math.round((value || 0) * 100)
  return (
    <div className="flex items-center gap-2 text-[11px] text-zinc-400">
      <span className="w-16 capitalize">{label}</span>
      <div className="h-1 flex-1 overflow-hidden rounded bg-zinc-800">
        <div className="h-full bg-zinc-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right tabular-nums">{value?.toFixed?.(2) ?? '—'}</span>
    </div>
  )
}

function IterationCard({ iteration, isBest }) {
  const { iteration_index, frame_urls, critic_score, critic_criteria, critic_feedback } = iteration
  return (
    <div className="flex min-w-[240px] flex-col gap-2 rounded-md border border-zinc-700 bg-zinc-950 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-200">Iteration {iteration_index}</span>
        <span className="flex items-center gap-1">
          {isBest && (
            <span className="rounded bg-amber-900 px-1.5 py-0.5 text-[10px] text-amber-200">
              ★ best
            </span>
          )}
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${scoreBadgeClass(critic_score)}`}>
            {critic_score?.toFixed?.(2) ?? '—'}
          </span>
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {(frame_urls || []).map((url, i) => (
          <img
            key={i}
            src={url}
            alt={`Iteration ${iteration_index} frame ${i}`}
            className="aspect-video w-full rounded border border-zinc-800 object-cover"
          />
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <CriteriaRow label="fidelity" value={critic_criteria?.fidelity} />
        <CriteriaRow label="legibility" value={critic_criteria?.legibility} />
        <CriteriaRow label="style" value={critic_criteria?.style} />
        <CriteriaRow label="timing" value={critic_criteria?.timing} />
      </div>
      <p className="text-[11px] leading-snug text-zinc-300">{critic_feedback}</p>
    </div>
  )
}

export function IterationHistoryPanel({ iterations, loading, error }) {
  if (loading) {
    return (
      <div className="px-4 py-3 text-xs text-zinc-400">Loading iteration history…</div>
    )
  }
  if (error) {
    return (
      <div className="px-4 py-3 text-xs text-red-300">Failed to load: {error}</div>
    )
  }
  if (!iterations || iterations.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-zinc-500">No iterations recorded.</div>
    )
  }
  const bestScore = Math.max(...iterations.map((i) => i.critic_score ?? 0))
  return (
    <div className="flex gap-3 overflow-x-auto px-4 py-3">
      {iterations.map((it) => (
        <IterationCard
          key={it.id}
          iteration={it}
          isBest={(it.critic_score ?? 0) === bestScore}
        />
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/components/motion-graphics/__tests__/IterationHistoryPanel.test.jsx
```

Expected: 9/9 pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/motion-graphics/IterationHistoryPanel.jsx src/components/motion-graphics/__tests__/IterationHistoryPanel.test.jsx
git commit -m "feat(graphics): IterationHistoryPanel component"
```

---

### Task 4: Wire panel into `RenderViewer` with toggle

**Files:**
- Modify: `src/components/motion-graphics/RenderViewer.jsx`
- Modify: `src/components/motion-graphics/__tests__/RenderViewer.test.jsx`

Show the toggle ("View N iterations" / "Hide iterations") only when the render is complete AND `iteration_count > 1` (single-iteration renders had no critic loop or one-shot success — no value in expanding). Click toggles expanded state and triggers `load()` on the hook.

- [ ] **Step 1: Update the failing tests**

Replace `src/components/motion-graphics/__tests__/RenderViewer.test.jsx` with:

```jsx
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';

const apiGetMock = vi.fn()
vi.mock('../../../hooks/useApi.js', () => ({
  apiGet: (...args) => apiGetMock(...args),
}))

beforeEach(() => { apiGetMock.mockReset() })
afterEach(cleanup);

const { RenderViewer } = await import('../RenderViewer.jsx');

describe('RenderViewer', () => {
  it('shows queued status placeholder', () => {
    render(<RenderViewer render={{ id: 1, iteration: 1, status: 'queued' }} />);
    expect(screen.getByText(/queued/i)).toBeDefined();
  });

  it('shows failed message', () => {
    render(<RenderViewer render={{ id: 1, iteration: 1, status: 'failed', error_message: 'oops' }} />);
    expect(screen.getByText(/failed: oops/i)).toBeDefined();
  });

  it('renders video + download link when complete', () => {
    const r = { id: 1, iteration: 2, status: 'complete', output_url: 'https://x.example/out.mp4', duration_ms: 8400, iteration_count: 1 };
    const { container } = render(<RenderViewer render={r} />);
    const video = container.querySelector('video');
    expect(video).toBeDefined();
    expect(video.getAttribute('src')).toBe('https://x.example/out.mp4');
    expect(screen.getByText(/download mp4/i)).toBeDefined();
  });

  it('does NOT show iteration toggle when iteration_count <= 1', () => {
    const r = { id: 1, iteration: 2, status: 'complete', output_url: 'https://x/out.mp4', duration_ms: 1000, iteration_count: 1 };
    render(<RenderViewer render={r} />);
    expect(screen.queryByText(/view .* iteration/i)).toBeNull();
  });

  it('shows iteration toggle when iteration_count > 1', () => {
    const r = { id: 5, iteration: 2, status: 'complete', output_url: 'https://x/out.mp4', duration_ms: 1000, iteration_count: 3 };
    render(<RenderViewer render={r} />);
    expect(screen.getByText(/view 3 iterations/i)).toBeDefined();
  });

  it('expanding the toggle fetches iterations and renders the panel', async () => {
    apiGetMock.mockResolvedValueOnce([
      { id: 11, iteration_index: 0, frame_urls: [], critic_score: 0.4, critic_criteria: { fidelity: 0.4, legibility: 0.4, style: 0.4, timing: 0.4 }, critic_feedback: 'fa' },
      { id: 12, iteration_index: 1, frame_urls: [], critic_score: 0.85, critic_criteria: { fidelity: 0.9, legibility: 0.9, style: 0.8, timing: 0.8 }, critic_feedback: 'fb' },
    ])
    const r = { id: 5, iteration: 2, status: 'complete', output_url: 'https://x/out.mp4', duration_ms: 1000, iteration_count: 2 };
    render(<RenderViewer render={r} />);
    fireEvent.click(screen.getByText(/view 2 iterations/i));
    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith('/graphics/renders/5/iterations');
      expect(screen.getByText(/iteration 0/i)).toBeDefined();
      expect(screen.getByText(/iteration 1/i)).toBeDefined();
    });
    expect(screen.getByText(/hide iterations/i)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/components/motion-graphics/__tests__/RenderViewer.test.jsx
```

Expected: 3 new tests fail (no toggle yet).

- [ ] **Step 3: Update `RenderViewer.jsx`**

Full replacement of `src/components/motion-graphics/RenderViewer.jsx`:

```jsx
import { useState } from 'react';
import { useIterationHistory } from '../../hooks/useIterationHistory.js';
import { IterationHistoryPanel } from './IterationHistoryPanel.jsx';

export function RenderViewer({ render }) {
  const [expanded, setExpanded] = useState(false);
  const iterCount = render.iteration_count ?? 1;
  const showToggle = render.status === 'complete' && iterCount > 1;
  const { iterations, loading, error, load } = useIterationHistory(render.id);

  const onToggle = () => {
    if (!expanded) load();
    setExpanded((v) => !v);
  };

  if (render.status === 'queued' || render.status === 'running') {
    return (
      <div className="my-3 rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-sm text-zinc-400">
        Render #{render.iteration} — {render.status}…
      </div>
    );
  }
  if (render.status === 'failed') {
    return (
      <div className="my-3 rounded-lg border border-red-700 bg-red-950 p-4 text-sm text-red-200">
        Render #{render.iteration} failed: {render.error_message}
      </div>
    );
  }
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900">
      <video src={render.output_url} controls className="block w-full max-w-2xl" />
      <div className="flex items-center justify-between px-4 py-2 text-xs text-zinc-400">
        <span>
          Render #{render.iteration} · {(render.duration_ms / 1000).toFixed(1)}s
          {render.final_score != null && render.final_score < 0.7 && (
            <span className="ml-2 rounded bg-amber-900 px-2 py-0.5 text-amber-200">
              low confidence
            </span>
          )}
        </span>
        <a href={render.output_url} download className="text-amber-400 hover:underline">
          Download MP4
        </a>
      </div>
      {showToggle && (
        <button
          type="button"
          onClick={onToggle}
          className="block w-full border-t border-zinc-800 bg-zinc-950 px-4 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-900"
        >
          {expanded ? 'Hide iterations' : `View ${iterCount} iterations`}
        </button>
      )}
      {showToggle && expanded && (
        <div className="border-t border-zinc-800 bg-zinc-950">
          <IterationHistoryPanel iterations={iterations} loading={loading} error={error} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/components/motion-graphics/__tests__/RenderViewer.test.jsx
```

Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/motion-graphics/RenderViewer.jsx src/components/motion-graphics/__tests__/RenderViewer.test.jsx
git commit -m "feat(graphics): expandable iteration history in RenderViewer"
```

---

### Task 5: Verify full graphics test suite

**Files:** none modified.

- [ ] **Step 1: Run all graphics-related tests**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/graphics-iteration-history-ui"
npx vitest run server/routes/__tests__/graphics.test.js src/hooks/__tests__/useIterationHistory.test.jsx src/components/motion-graphics/__tests__/
```

Expected: all green.

- [ ] **Step 2: Run full client + server suites**

```bash
npx vitest run server/ src/
```

Expected: green or no NEW failures vs. parent branch baseline. Pre-existing graphics-unrelated failures (e.g., `integration-flow.test.js` was failing before this work — confirm it's still the same failure, not a new one).

- [ ] **Step 3: No commit (checkpoint only)**

---

### Task 6: Manual smoke

**Files:** none.

- [ ] **Step 1: Boot dev server (frontend only — see CAUTION)**

CAUTION (durable feedback): `npm run dev:server` triggers auto-resume of stuck b-roll chains and is hazardous. For this UI smoke, prefer `npm run dev` (the Vite frontend server) and use the existing prod backend (or whatever backend's already running). Do NOT start `dev:server`.

If a backend is already running on the dev DB with seeded data, skip to Step 2. Otherwise SKIP this entire task and report the smoke as deferred — the unit tests cover behavior thoroughly.

- [ ] **Step 2: Open a graphics session with a multi-iteration render**

In the running app, navigate to a graphics session that has a render with `iteration_count > 1`. (You can verify the data exists by querying directly: `SELECT id, iteration_count FROM graphics_renders WHERE iteration_count > 1 LIMIT 5;`.)

If no such render exists in the dev DB, manually trigger one by sending a brief that fails the critic on first attempt — easiest with vague prompts that lead to low-fidelity output. Or use the integration test fixture data if it persists.

- [ ] **Step 3: Verify the toggle**

Expected:
1. RenderViewer shows the video player and "View N iterations" button at the bottom.
2. Click the button → panel expands, shows loading state momentarily, then renders N iteration cards in a horizontal scrollable strip.
3. Each card shows: iteration index, score badge (color-coded), 4 frame thumbnails, criteria bars (fidelity/legibility/style/timing), feedback paragraph.
4. Best (highest-score) iteration has a "★ best" marker.
5. Button text changes to "Hide iterations".
6. Click again → panel collapses.

- [ ] **Step 4: Visual sanity check + screenshot**

Save a screenshot (the user will inspect it). Check:
- No layout overflow when 3 cards present
- Frame thumbnails load (if Supabase frame URLs are public; if not, that's a pre-existing data issue, NOT a 3.2 bug)
- Score colors: red <0.6, amber 0.6-0.8, emerald ≥0.8
- Mobile: cards scroll horizontally, no broken layout

If any of the above fail, document the issue but do NOT fix in this plan — file as a follow-up and ship 3.2 unless it's a hard blocker.

- [ ] **Step 5: Do NOT push**

Per durable feedback ("don't push without asking"), STOP after the smoke. The user will trigger the push themselves.

---

## Self-Review (controller)

**Spec coverage:**
- ✅ "Expandable panel showing all 3 attempts side-by-side" → Tasks 3+4
- ✅ Backend access to per-iteration data → Task 1
- ✅ Lazy load (don't blow up the session-load payload) → Task 2 hook
- ✅ Tests at every layer (route, hook, panel, integration in RenderViewer) → all tasks
- ✅ Existing pipeline untouched → critic-runner / render-worker / db.js called out as untouched

**Placeholder scan:** None. Every step has full code.

**Type consistency:**
- Server returns `frame_urls` (parsed array) and `critic_criteria` (parsed object). Client consumes those shapes. Hook + component agree.
- `iteration_count` field on render comes from the existing `graphics_renders` table column (verified via Phase 2 schema).
- Score is `NUMERIC(3,2)` in DB → JS number on read. Component handles `null` with `?.toFixed?.()` guard.

**Risks called out:**
- Frame thumbnail URLs: Phase 2's `uploader.js` uploads to Supabase. If the bucket isn't public (per pending Phase 2 follow-up: "Create `graphics-frames` Supabase storage bucket for production"), images will 404. The component handles this gracefully (broken-image rendering) — but the smoke test should flag if URLs aren't loading. This is NOT a 3.2 bug; it's the upstream Phase 2 todo.
- DB-driver JSONB shape: PG driver returns objects; the test mock returns whatever fixture sets. The route's `typeof === 'string'` guard handles both. Verified by the test fixture passing arrays directly (the mock won't stringify them).
- Iteration ordering: route enforces `ORDER BY iteration_index ASC`. The "best" calculation in the component is independent of order — uses `Math.max` over scores, not the last element.
