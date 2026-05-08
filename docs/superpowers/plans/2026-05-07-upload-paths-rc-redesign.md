# Upload Paths + Rough Cut Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse three upload paths into two — "Auto + Rough Cut" (primary) and "Strategy + Rough Cut" — make rough-cut review the default, replace the rough-cut Export button with Continue (which resumes the pipeline), remove Export from strategy review, and surface a "review your rough cut" banner during the hands-off auto path while gating sidebar Strategy clicks behind processing completion.

**Architecture:** Reuse existing `path_id` values (`hands-off`, `strategy-only`) rather than introduce new ones. Hide the `guided` picker card but keep its code paths intact for legacy projects. Extend `chainAfterRoughCut` so `strategy-only + auto_rough_cut=true` triggers the same `paused_at_rough_cut` state currently exclusive to guided. Reuse the existing `paused_at_rough_cut` resume handler (`handleResumeFromRoughCut` in `EditorView.jsx`) for the Continue button.

**Tech Stack:** React 19 + Vite frontend, Express + Postgres backend, Vitest for unit/component tests, React Testing Library.

---

## File Map

**Modify:**
- `src/components/upload-config/UploadConfigFlow.jsx` — defaults
- `src/components/upload-config/steps/StepPath.jsx` — picker cards
- `src/components/editor/EditorView.jsx` — top-bar Export → Continue/hide
- `src/components/editor/EditorSidebar.jsx` — Strategy click guard
- `src/components/views/ProcessingModal.jsx` — review-rough-cut banner, strategy-only-with-RC pause handling
- `server/services/auto-orchestrator.js` — pause strategy-only at rough cut when auto_rough_cut=true
- `src/components/upload-config/steps/__tests__/StepPath.test.jsx` (create or extend if exists)
- `server/services/__tests__/auto-orchestrator.test.js` — extend
- `src/components/views/__tests__/ProcessingModal-stages.test.jsx` — extend
- `src/components/editor/__tests__/EditorSidebar.test.jsx` (create if absent)

**Out of scope:** No DB migration. Existing `path_id='guided'` projects keep their flow. The `StepRoughCut` wizard step is unchanged (toggle stays).

---

## Task 1: Default to Auto + Rough Cut

**Files:**
- Modify: `src/components/upload-config/UploadConfigFlow.jsx:36-39`
- Test: `src/components/upload-config/__tests__/UploadConfigFlow-defaults.test.jsx` (create)

- [ ] **Step 1: Write the failing test**

Create `src/components/upload-config/__tests__/UploadConfigFlow-defaults.test.jsx`:

```jsx
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/upload-config/__tests__/UploadConfigFlow-defaults.test.jsx`
Expected: FAIL — `DEFAULT_STATE` is not exported (or values mismatch).

- [ ] **Step 3: Export DEFAULT_STATE and update its values**

In `src/components/upload-config/UploadConfigFlow.jsx`, change `const DEFAULT_STATE = {` (line 26) to `export const DEFAULT_STATE = {`. Update lines 37-38 from:

```js
  pathId: 'strategy-only',
  autoRoughCut: false,
```

to:

```js
  pathId: 'hands-off',
  autoRoughCut: true,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/upload-config/__tests__/UploadConfigFlow-defaults.test.jsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/upload-config/UploadConfigFlow.jsx src/components/upload-config/__tests__/UploadConfigFlow-defaults.test.jsx
git commit -m "feat(upload): default pathId=hands-off and autoRoughCut=true

Auto + Rough Cut is the primary upload path."
```

---

## Task 2: Path Picker — Two Cards, Reordered, Renamed

**Files:**
- Modify: `src/components/upload-config/steps/StepPath.jsx:22-84` (`buildPaths`)
- Test: `src/components/upload-config/steps/__tests__/StepPath.test.jsx` (create)

- [ ] **Step 1: Write the failing test**

Create `src/components/upload-config/steps/__tests__/StepPath.test.jsx`:

```jsx
import { describe, it, expect } from 'vitest'
import { buildPaths } from '../StepPath.jsx'

describe('buildPaths', () => {
  it('returns exactly two paths (no guided card)', () => {
    const paths = buildPaths(true)
    expect(paths).toHaveLength(2)
    expect(paths.map(p => p.id)).toEqual(['hands-off', 'strategy-only'])
  })

  it('lists hands-off first with primary tone', () => {
    const paths = buildPaths(true)
    expect(paths[0].id).toBe('hands-off')
    expect(paths[0].tone).toBe('primary')
  })

  it('renames cards to include "+ Rough Cut" when autoRoughCut=true', () => {
    const paths = buildPaths(true)
    expect(paths[0].title).toBe('Auto + Rough Cut')
    expect(paths[1].title).toBe('Strategy + Rough Cut')
  })

  it('uses plain Auto / Strategy titles when autoRoughCut=false', () => {
    const paths = buildPaths(false)
    expect(paths[0].title).toBe('Auto')
    expect(paths[1].title).toBe('Strategy')
  })

  it('hands-off includes a non-checkpoint rough cut review step when autoRoughCut=true', () => {
    const paths = buildPaths(true)
    const handsOff = paths[0]
    const reviewStep = handsOff.flow.find(s => s.label === 'Rough cut review')
    expect(reviewStep).toBeDefined()
    expect(reviewStep.checkpoint).toBeFalsy()
  })

  it('strategy-only includes a checkpoint rough cut review step when autoRoughCut=true', () => {
    const paths = buildPaths(true)
    const strategy = paths[1]
    const reviewStep = strategy.flow.find(s => s.label === 'Rough cut review')
    expect(reviewStep).toBeDefined()
    expect(reviewStep.checkpoint).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/upload-config/steps/__tests__/StepPath.test.jsx`
Expected: FAIL — `buildPaths` not exported (current code has it as a local function), and once exported, content tests fail (3 paths returned, wrong titles).

- [ ] **Step 3: Rewrite `buildPaths` and export it**

In `src/components/upload-config/steps/StepPath.jsx`, replace the comment block (lines 16-21) and `function buildPaths(autoRoughCut)` (line 22) through the end of the function (line 84). Replace with:

```js
// Two paths after the guided-card removal:
//   - 'hands-off' (Auto + Rough Cut) is the primary default. Rough cut review
//     surfaces as a non-checkpoint step — pipeline keeps running through to
//     b-roll, the user is just notified to review.
//   - 'strategy-only' (Strategy + Rough Cut) pauses at rough cut review AND
//     at strategy review when autoRoughCut=true. Without rough cut, it only
//     pauses at strategy review (current behavior).
// When autoRoughCut=false the cards drop the "+ Rough Cut" suffix.
export function buildPaths(autoRoughCut) {
  const handsOffFlow = [
    ...(autoRoughCut ? [{ label: 'Rough cut review', status: 'review' }] : []),
    { label: 'References analyzed', status: 'auto' },
    { label: 'Strategy proposal',   status: 'auto' },
    { label: 'B-roll plan',         status: 'auto' },
    { label: 'Search & download',   status: 'auto' },
    { label: 'Final review',        status: 'review', checkpoint: true },
  ]
  const strategyFlow = [
    ...(autoRoughCut ? [{ label: 'Rough cut review', status: 'review', checkpoint: true }] : []),
    { label: 'References analyzed', status: 'auto' },
    { label: 'Strategy proposal',   status: 'review', checkpoint: true },
    { label: 'B-roll plan',         status: 'auto' },
    { label: 'Search & download',   status: 'auto' },
    { label: 'Final review',        status: 'review', checkpoint: true },
  ]
  return [
    {
      id: 'hands-off',
      badge: 'A · RECOMMENDED',
      title: autoRoughCut ? 'Auto + Rough Cut' : 'Auto',
      subtitle: 'Start now, email when b-roll is ready',
      tone: 'primary',
      icon: 'rocket_launch',
      flow: handsOffFlow,
      eta: '~18–24 hrs for a 40-min video',
      note: 'Kick it off and walk away — review the rough cut on the side, the pipeline keeps running.',
    },
    {
      id: 'strategy-only',
      badge: 'B · CHECKPOINTED',
      title: autoRoughCut ? 'Strategy + Rough Cut' : 'Strategy',
      subtitle: 'Confirm the rough cut and the strategy, then we run',
      tone: 'tertiary',
      icon: 'center_focus_strong',
      flow: strategyFlow,
      eta: '~24–32 hrs for a 40-min video',
      note: "Each checkpoint waits on your login — without it, the next phase won't start.",
      warn: true,
    },
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/upload-config/steps/__tests__/StepPath.test.jsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Verify pre-existing path-id-fallback effect still compiles**

Run: `npx vitest run src/components/upload-config/`
Expected: All path-related tests pass. The existing useEffect at `StepPath.jsx:206-208` (which falls `pathId='guided'` back to `strategy-only` when rough cut turns off) is now dead code but harmless — no value can be `'guided'` from the picker. Leave it; it protects DB-loaded state from older projects.

- [ ] **Step 6: Commit**

```bash
git add src/components/upload-config/steps/StepPath.jsx src/components/upload-config/steps/__tests__/StepPath.test.jsx
git commit -m "feat(upload): collapse to two path cards with rough-cut bundling

- Removes the guided card; hands-off + strategy-only remain.
- hands-off is primary tone, listed first.
- Cards rename to 'Auto + Rough Cut' / 'Strategy + Rough Cut' when
  autoRoughCut is on; otherwise plain 'Auto' / 'Strategy'.
- hands-off shows a non-checkpoint rough-cut review step;
  strategy-only treats it as a blocking checkpoint."
```

---

## Task 3: Backend — Pause Strategy-Only at Rough Cut When auto_rough_cut=true

**Files:**
- Modify: `server/services/auto-orchestrator.js:367-398` (`chainAfterRoughCut`)
- Test: `server/services/__tests__/auto-orchestrator.test.js` (extend)

- [ ] **Step 1: Inspect existing test setup**

Run: `head -80 server/services/__tests__/auto-orchestrator.test.js`
Note the mock structure for `db.prepare` and `__orchestratorDeps` so the new tests follow the same pattern.

- [ ] **Step 2: Write the failing test**

Append to `server/services/__tests__/auto-orchestrator.test.js`. Place inside the existing top-level `describe` for `chainAfterRoughCut` if one exists; otherwise add a new describe block. Replace `<existing-mock-setup>` placeholders with the patterns visible at the top of the file:

```js
describe('chainAfterRoughCut — strategy-only with auto_rough_cut', () => {
  it('pauses strategy-only at rough cut when auto_rough_cut is true', async () => {
    const updates = []
    const emails = []
    const runChain = vi.fn()

    vi.doMock('../../db.js', () => ({
      default: {
        prepare: (sql) => ({
          get: () => ({
            user_id: 'u1',
            path_id: 'strategy-only',
            auto_rough_cut: true,
            broll_chain_status: null,
          }),
          run: (id) => { updates.push({ sql, id }) },
        }),
      },
    }))
    vi.doMock('../email-notifier.js', () => ({
      send: async (kind, payload) => { emails.push({ kind, ...payload }) },
    }))

    const orch = await import('../auto-orchestrator.js')
    orch.__orchestratorDeps.runFullAutoBrollChain = runChain

    await orch.chainAfterRoughCut(42)

    expect(updates).toHaveLength(1)
    expect(updates[0].sql).toMatch(/paused_at_rough_cut/)
    expect(updates[0].id).toBe(42)
    expect(emails).toEqual([{ kind: 'paused_at_rough_cut', subGroupId: 42, userId: 'u1' }])
    expect(runChain).not.toHaveBeenCalled()
  })

  it('still kicks chain for strategy-only when auto_rough_cut is false', async () => {
    const updates = []
    const runChain = vi.fn().mockResolvedValue(undefined)

    vi.doMock('../../db.js', () => ({
      default: {
        prepare: (sql) => ({
          get: () => ({
            user_id: 'u1',
            path_id: 'strategy-only',
            auto_rough_cut: false,
            broll_chain_status: null,
          }),
          run: () => { updates.push(sql) },
        }),
      },
    }))

    const orch = await import('../auto-orchestrator.js')
    orch.__orchestratorDeps.runFullAutoBrollChain = runChain

    await orch.chainAfterRoughCut(43)

    expect(updates.filter(s => /paused_at_rough_cut/.test(s))).toHaveLength(0)
    expect(runChain).toHaveBeenCalledWith(43)
  })

  it('still kicks chain for hands-off regardless of auto_rough_cut', async () => {
    const runChain = vi.fn().mockResolvedValue(undefined)

    vi.doMock('../../db.js', () => ({
      default: {
        prepare: () => ({
          get: () => ({
            user_id: 'u1',
            path_id: 'hands-off',
            auto_rough_cut: true,
            broll_chain_status: null,
          }),
          run: () => {},
        }),
      },
    }))

    const orch = await import('../auto-orchestrator.js')
    orch.__orchestratorDeps.runFullAutoBrollChain = runChain

    await orch.chainAfterRoughCut(44)

    expect(runChain).toHaveBeenCalledWith(44)
  })
})
```

If the existing test file uses a different mocking style (e.g. `vi.mock` at the top), conform to that style instead of `vi.doMock` and adapt the mocks accordingly. The contract under test stays the same: strategy-only + auto_rough_cut=true → paused_at_rough_cut + email + no chain fire; otherwise → chain fire.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run server/services/__tests__/auto-orchestrator.test.js`
Expected: FAIL — strategy-only currently always kicks the chain.

- [ ] **Step 4: Update `chainAfterRoughCut`**

In `server/services/auto-orchestrator.js`, replace the SELECT (line 369) and the guided branch (lines 382-393) so the function reads:

```js
export async function chainAfterRoughCut(groupId) {
  const g = await db.prepare(
    'SELECT user_id, path_id, auto_rough_cut, broll_chain_status FROM video_groups WHERE id = ?'
  ).get(groupId)
  if (!g) return
  if (!['hands-off', 'strategy-only', 'guided'].includes(g.path_id)) return

  // Don't clobber a chain that's already advanced past rough-cut review.
  if (['running', 'paused_at_strategy', 'paused_at_plan', 'done', 'failed'].includes(g.broll_chain_status)) {
    return
  }

  const shouldPauseAtRoughCut =
    g.path_id === 'guided' ||
    (g.path_id === 'strategy-only' && g.auto_rough_cut)

  if (shouldPauseAtRoughCut) {
    await db.prepare(
      "UPDATE video_groups SET broll_chain_status = 'paused_at_rough_cut' WHERE id = ?"
    ).run(groupId)
    try {
      const { send } = await import('./email-notifier.js')
      await send('paused_at_rough_cut', { subGroupId: groupId, userId: g.user_id })
    } catch (err) {
      console.error(`[chain-after-rough-cut] email failed for group ${groupId}:`, err.message)
    }
    return
  }

  // hands-off (or strategy-only with auto_rough_cut=false) — fire chain
  __orchestratorDeps.runFullAutoBrollChain(groupId)
    .catch(err => console.error(`[chain] ${err.message}`))
}
```

Also update the JSDoc comment block above (lines 358-366) so it matches the new behavior:

```js
// chainAfterRoughCut — called when rough cut reaches a TERMINAL state for a
// (sub-)group. Sets broll_chain_status='paused_at_rough_cut' (and emails the
// user) when the path requires a rough-cut review checkpoint:
//   - guided (legacy projects)
//   - strategy-only with auto_rough_cut=true
// Otherwise (hands-off, or strategy-only without auto_rough_cut) it kicks
// off the b-roll chain. No-op for null path_id (legacy / manual projects).
//
// Safe to call from any rough-cut completion site (rough-cut-runner.js IIFE,
// or multicam-sync.js for the already_exists / kickoff-failure cases).
// Idempotent enough: paused_at_rough_cut is a state flip; chain duplicate-fire
// is guarded by runFullAutoBrollChain's heartbeat lock.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/services/__tests__/auto-orchestrator.test.js`
Expected: PASS for the new three tests; existing tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/auto-orchestrator.js server/services/__tests__/auto-orchestrator.test.js
git commit -m "feat(orchestrator): pause strategy-only at rough cut when auto_rough_cut=true

Mirrors the legacy guided-path behavior so the new 'Strategy + Rough Cut'
upload path stops at the rough-cut review checkpoint."
```

---

## Task 4: Continue Button Replaces Export on Rough Cut Tab

**Files:**
- Modify: `src/components/editor/EditorView.jsx:1026-1031` (top-bar buttons)

The Export button at line 1026 currently always renders. Make it conditional on `activeTab` and add a Continue button for the rough-cut tab. Continue's behavior: navigate to the processing modal, and if the chain is paused at rough cut, also fire the existing resume handler.

- [ ] **Step 1: Locate `activeTab` and `parentGroupId` already in scope**

Run: `grep -n "activeTab\|parent_group_id\|parentGroupId\|groupDetail" src/components/editor/EditorView.jsx | head -20`
Confirm `activeTab` and `groupDetail` are already in render scope. The parent group id is on `groupDetail.parent_group_id` (when this group is a sub-group). For top-level groups it's null and Continue should navigate using the editor's own `id`.

- [ ] **Step 2: Add Continue handler**

In `src/components/editor/EditorView.jsx`, after the existing `handleResumeFromRoughCut` function (around line 391), add:

```js
  // Continue button on the rough-cut tab. For strategy-only + auto_rough_cut
  // (and legacy guided), the chain is paused at paused_at_rough_cut and we
  // need to fire the resume before navigating. For hands-off the chain is
  // already running — Continue is just navigation back to the processing
  // page so the user can see what's still in flight.
  const handleContinueFromRoughCut = async () => {
    if (groupDetail?.broll_chain_status === 'paused_at_rough_cut') {
      try { await fireResumeFromRoughCut() } catch {}
    }
    const targetGroupId = groupDetail?.parent_group_id ?? id
    navigate(`/?step=processing&group=${targetGroupId}`)
  }
```

- [ ] **Step 3: Replace the Export button block**

In `src/components/editor/EditorView.jsx`, replace lines 1026-1031:

```jsx
            <button
              onClick={() => window.open(`/editor/${id}/export`, '_blank')}
              className="px-6 py-1.5 rounded-md font-bold text-sm bg-gradient-to-br from-primary-fixed to-primary-dim text-on-primary-fixed hover:opacity-90 transition-all"
            >
              Export
            </button>
```

with:

```jsx
            {activeTab === 'roughcut' ? (
              <button
                onClick={handleContinueFromRoughCut}
                className="px-6 py-1.5 rounded-md font-bold text-sm bg-gradient-to-br from-primary-fixed to-primary-dim text-on-primary-fixed hover:opacity-90 transition-all"
              >
                Continue
              </button>
            ) : activeTab === 'brolls' ? null : (
              <button
                onClick={() => window.open(`/editor/${id}/export`, '_blank')}
                className="px-6 py-1.5 rounded-md font-bold text-sm bg-gradient-to-br from-primary-fixed to-primary-dim text-on-primary-fixed hover:opacity-90 transition-all"
              >
                Export
              </button>
            )}
```

This single change covers both Task 4 (rough-cut → Continue) and Task 5 (strategy/brolls → no Export).

- [ ] **Step 4: Smoke check**

Run: `npx vitest run src/components/editor/`
Expected: Existing editor tests still pass (no behavioral regressions for assets/sync). The pre-existing failure in `EditorView-failed-redirect.test.jsx` (test 4 of the baseline) is unrelated and should remain at the same failure mode.

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/EditorView.jsx
git commit -m "feat(editor): swap Export for Continue on rough cut, hide on broll tabs

Rough cut: Continue resumes paused_at_rough_cut chain (when applicable)
and routes the user to /?step=processing.
B-roll strategy / B-roll editor: Export is suppressed for now."
```

---

## Task 5: Sidebar Strategy Click Redirects to Processing While Chain In-Flight

**Files:**
- Modify: `src/components/editor/EditorSidebar.jsx`
- Modify: `src/components/editor/EditorView.jsx` — pass new props
- Test: `src/components/editor/__tests__/EditorSidebar.test.jsx` (create)

The sidebar currently routes `brolls-strategy` clicks to `onTabChange('brolls/strategy')`. When the b-roll chain is `running`/`pending` (active but not paused, not done), redirect to the processing page instead.

- [ ] **Step 1: Write the failing test**

Create `src/components/editor/__tests__/EditorSidebar.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditorSidebar from '../EditorSidebar.jsx'

vi.mock('../../../contexts/RoleContext.jsx', () => ({
  useRole: () => ({ isAdmin: false }),
}))

const baseProps = {
  activeTab: 'sync',
  assemblyStatus: 'done',
  hasVideos: true,
  hasBrollSearch: true,
}

describe('EditorSidebar — Strategy click guard', () => {
  it('routes Strategy click to /?step=processing when chain is running', async () => {
    const onNavigateToProcessing = vi.fn()
    const onTabChange = vi.fn()
    render(
      <EditorSidebar
        {...baseProps}
        brollChainStatus="running"
        parentGroupId={42}
        onNavigateToProcessing={onNavigateToProcessing}
        onTabChange={onTabChange}
      />
    )
    await userEvent.click(screen.getByText(/B-Roll Strategy/i))
    expect(onNavigateToProcessing).toHaveBeenCalledWith(42)
    expect(onTabChange).not.toHaveBeenCalled()
  })

  it('routes Strategy click normally when chain is done', async () => {
    const onNavigateToProcessing = vi.fn()
    const onTabChange = vi.fn()
    render(
      <EditorSidebar
        {...baseProps}
        brollChainStatus="done"
        parentGroupId={42}
        onNavigateToProcessing={onNavigateToProcessing}
        onTabChange={onTabChange}
      />
    )
    await userEvent.click(screen.getByText(/B-Roll Strategy/i))
    expect(onTabChange).toHaveBeenCalledWith('brolls/strategy')
    expect(onNavigateToProcessing).not.toHaveBeenCalled()
  })

  it('keeps the existing paused_at_rough_cut resume behavior', async () => {
    const onResumeFromRoughCut = vi.fn()
    const onNavigateToProcessing = vi.fn()
    const onTabChange = vi.fn()
    render(
      <EditorSidebar
        {...baseProps}
        brollChainStatus="paused_at_rough_cut"
        parentGroupId={42}
        onResumeFromRoughCut={onResumeFromRoughCut}
        onNavigateToProcessing={onNavigateToProcessing}
        onTabChange={onTabChange}
      />
    )
    await userEvent.click(screen.getByText(/B-Roll Strategy/i))
    expect(onResumeFromRoughCut).toHaveBeenCalled()
    expect(onNavigateToProcessing).not.toHaveBeenCalled()
    expect(onTabChange).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/editor/__tests__/EditorSidebar.test.jsx`
Expected: FAIL — sidebar doesn't accept `parentGroupId` / `onNavigateToProcessing` and currently routes the click straight through.

- [ ] **Step 3: Update EditorSidebar to accept the guard props**

In `src/components/editor/EditorSidebar.jsx`, update the component signature (the `export default function EditorSidebar({ ... })` block) to accept `parentGroupId` and `onNavigateToProcessing`:

```jsx
export default function EditorSidebar({
  activeTab = 'sync',
  activeSub,
  assemblyStatus,
  hasVideos = true,
  hasBrollSearch = false,
  brollChainStatus = null,
  parentGroupId = null,
  onTabChange,
  onResumeFromRoughCut,
  onNavigateToProcessing,
}) {
```

Replace the `handleClick` function inside the `.map` so it also redirects to processing when the chain is active but not paused/done:

```jsx
          const chainInFlight =
            brollChainStatus === 'running' || brollChainStatus === 'pending'

          const handleClick = () => {
            if (disabled) return
            if (pausedAtRoughCut && item.id === 'brolls-strategy') {
              onResumeFromRoughCut?.()
              return
            }
            if (chainInFlight && item.id === 'brolls-strategy') {
              onNavigateToProcessing?.(parentGroupId)
              return
            }
            onTabChange?.(item.navTo || item.id)
          }
```

Note: `pausedAtRoughCut` already covers `paused_at_rough_cut`. The new branch only handles `running`/`pending` so `paused_at_strategy`/`paused_at_plan` continue to navigate normally (the user needs to be able to act on those reviews).

- [ ] **Step 4: Run test to verify sidebar test passes**

Run: `npx vitest run src/components/editor/__tests__/EditorSidebar.test.jsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire EditorView to pass new props**

In `src/components/editor/EditorView.jsx`, find the `<EditorSidebar` element (around line 1057) and add the two new props. Use `useNavigate`'s `navigate` (already in scope):

```jsx
          <EditorSidebar
            activeTab={activeTab}
            activeSub={sub}
            assemblyStatus={groupDetail?.assembly_status}
            hasVideos={groupDetail?.videos?.length > 0}
            hasBrollSearch={hasBrollSearch}
            brollChainStatus={groupDetail?.broll_chain_status}
            parentGroupId={groupDetail?.parent_group_id ?? id}
            onResumeFromRoughCut={handleResumeFromRoughCut}
            onNavigateToProcessing={(gid) => navigate(`/?step=processing&group=${gid}`)}
            onTabChange={(newTab) => {
              ...
            }}
          />
```

- [ ] **Step 6: Verify the editor tests still pass**

Run: `npx vitest run src/components/editor/`
Expected: All editor tests still pass (the pre-existing `EditorView-failed-redirect` failure remains unchanged, baseline).

- [ ] **Step 7: Commit**

```bash
git add src/components/editor/EditorSidebar.jsx src/components/editor/EditorView.jsx src/components/editor/__tests__/EditorSidebar.test.jsx
git commit -m "feat(editor-sidebar): redirect Strategy click to processing while chain in flight

When broll_chain_status is running/pending, clicking 'B-Roll Strategy' opens
the processing page instead of the strategy view. paused_at_rough_cut still
fires the existing resume handler; paused_at_strategy/_at_plan still navigate
normally so the user can act on those review checkpoints."
```

---

## Task 6: Processing Modal — Review-Rough-Cut Banner & Strategy-Only-with-RC Pause

**Files:**
- Modify: `src/components/views/ProcessingModal.jsx` (banner + stage logic)
- Test: `src/components/views/__tests__/ProcessingModal-stages.test.jsx` (extend)

The modal already handles `paused_at_rough_cut` for the legacy guided path (line 835 `pausedAtRoughCutSg`). It will start firing for `strategy-only + auto_rough_cut=true` projects automatically because we changed `chainAfterRoughCut`. We need:
1. The "Review your rough cut" banner for `hands-off` (chain runs through, user nudge only).
2. Verify the existing pausedRoute logic correctly resolves for strategy-only.

- [ ] **Step 1: Read the existing pausedRoute branch and banner area**

Run: `sed -n '830,890p' src/components/views/ProcessingModal.jsx`
Note where the stage list renders and where banners (if any) sit. The banner should render above the stage list and only for hands-off + auto_rough_cut + RC done + chain still in flight.

- [ ] **Step 2: Write the failing test**

Append a new describe block to `src/components/views/__tests__/ProcessingModal-stages.test.jsx`:

```jsx
import { describe, it, expect } from 'vitest'
import { deriveStages } from '../ProcessingModal.jsx'

describe('ProcessingModal — strategy-only + auto_rough_cut pause', () => {
  it('treats paused_at_rough_cut on strategy-only as a rough-cut paused state', () => {
    const parent = {
      auto_rough_cut: true,
      path_id: 'strategy-only',
    }
    const subGroups = [{
      id: 1,
      assembly_status: 'done',
      rough_cut_status: 'done',
      broll_chain_status: 'paused_at_rough_cut',
    }]
    const stages = deriveStages({ parent, subGroups })
    const rc = stages.find(s => s.id === 'rough_cut')
    expect(rc.paused).toBe(true)
  })
})
```

If `deriveStages` is not exported, the existing test file will already have a workaround (it imports something for stage testing). Match its import style. If no helper is exported, this test can be expressed as a render-and-query test instead — see the existing tests in the file for the pattern.

- [ ] **Step 3: Run test to verify it fails OR passes already**

Run: `npx vitest run src/components/views/__tests__/ProcessingModal-stages.test.jsx`
The existing `brollPausedAtRough` derivation (`ProcessingModal.jsx:89`) already evaluates `subGroups.some(sg => sg.broll_chain_status === 'paused_at_rough_cut')` regardless of path_id. So this test is likely PASS without code change — that's fine, it locks the contract.

- [ ] **Step 4: Add a pure-helper test for the banner condition**

Refactor the banner-visibility check into an exported pure function so it's testable without rendering. In `src/components/views/ProcessingModal.jsx`, add (above `deriveStages` or near the other exports):

```js
// Banner is shown when hands-off + auto_rough_cut has finished the rough cut
// but the b-roll chain is still in flight (or paused at strategy/plan).
export function shouldShowReviewRoughCutBanner({ parent, subGroups }) {
  if (!parent || parent.path_id !== 'hands-off' || !parent.auto_rough_cut) return false
  if (!subGroups || subGroups.length === 0) return false
  if (!subGroups.every(sg => sg.rough_cut_status === 'done')) return false
  return subGroups.some(sg =>
    ['running', 'pending', 'paused_at_strategy', 'paused_at_plan'].includes(sg.broll_chain_status)
  )
}
```

Append to `src/components/views/__tests__/ProcessingModal-stages.test.jsx`:

```js
import { shouldShowReviewRoughCutBanner } from '../ProcessingModal.jsx'

describe('ProcessingModal — review your rough cut banner condition', () => {
  const sg = (overrides) => ({ id: 1, rough_cut_status: 'done', broll_chain_status: 'running', ...overrides })

  it('returns true for hands-off + auto_rough_cut + RC done + chain running', () => {
    expect(shouldShowReviewRoughCutBanner({
      parent: { path_id: 'hands-off', auto_rough_cut: true },
      subGroups: [sg()],
    })).toBe(true)
  })

  it('returns false when path_id is strategy-only', () => {
    expect(shouldShowReviewRoughCutBanner({
      parent: { path_id: 'strategy-only', auto_rough_cut: true },
      subGroups: [sg()],
    })).toBe(false)
  })

  it('returns false when auto_rough_cut is off', () => {
    expect(shouldShowReviewRoughCutBanner({
      parent: { path_id: 'hands-off', auto_rough_cut: false },
      subGroups: [sg()],
    })).toBe(false)
  })

  it('returns false when rough cut not yet done', () => {
    expect(shouldShowReviewRoughCutBanner({
      parent: { path_id: 'hands-off', auto_rough_cut: true },
      subGroups: [sg({ rough_cut_status: 'running' })],
    })).toBe(false)
  })

  it('returns false when chain is fully done', () => {
    expect(shouldShowReviewRoughCutBanner({
      parent: { path_id: 'hands-off', auto_rough_cut: true },
      subGroups: [sg({ broll_chain_status: 'done' })],
    })).toBe(false)
  })

  it('returns true when chain is paused at strategy (still in flight)', () => {
    expect(shouldShowReviewRoughCutBanner({
      parent: { path_id: 'hands-off', auto_rough_cut: true },
      subGroups: [sg({ broll_chain_status: 'paused_at_strategy' })],
    })).toBe(true)
  })
})
```

Run: `npx vitest run src/components/views/__tests__/ProcessingModal-stages.test.jsx`
Expected: FAIL — `shouldShowReviewRoughCutBanner` not yet exported. (After Step 5 it will pass.)

- [ ] **Step 5: Render the banner using the helper**

In `src/components/views/ProcessingModal.jsx`, locate the JSX where the stage list renders (inside the main return of the `ProcessingModal` component — near where `stages.map(...)` is called, around line 590+). Above the stage list, add:

```jsx
{shouldShowReviewRoughCutBanner({ parent, subGroups }) && (
  <div className="mb-4 rounded-lg border border-lime/30 bg-lime/5 px-4 py-3 flex items-center gap-3">
    <span className="material-symbols-outlined text-lime">content_cut</span>
    <div className="flex-1">
      <div className="text-sm font-bold text-on-surface">Rough cut ready — review while we keep working</div>
      <div className="text-xs text-on-surface-variant mt-0.5">Your b-roll search is still running. Open the rough cut to make adjustments.</div>
    </div>
    <button
      onClick={() => navigate(`/editor/${subGroups[0].id}/roughcut`)}
      className="px-4 py-1.5 rounded-md text-xs font-bold bg-lime text-black hover:opacity-90"
    >
      Review rough cut
    </button>
  </div>
)}
```

`navigate` is already in scope (`ProcessingModal.jsx` already calls `useNavigate()` — confirm at the top of the component before this edit; if not, add `import { useNavigate } from 'react-router-dom'` and `const navigate = useNavigate()`).

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/components/views/__tests__/ProcessingModal-stages.test.jsx`
Expected: All tests pass including the banner test.

- [ ] **Step 7: Commit**

```bash
git add src/components/views/ProcessingModal.jsx src/components/views/__tests__/ProcessingModal-stages.test.jsx
git commit -m "feat(processing-modal): review-rough-cut banner for hands-off path

When the hands-off pipeline finishes the rough cut and is still working
on b-roll, surface a banner inviting the user to review the cut while
the chain keeps running. Strategy-only + auto_rough_cut continues to
display the existing paused_at_rough_cut state."
```

---

## Task 7: Full Suite + Manual Smoke

- [ ] **Step 1: Run the full vitest suite**

Run: `npx vitest run`
Expected: 4 pre-existing failures (extension version mismatch, two `StepRoughCut` accessibility tests, one `EditorView-failed-redirect` for guided) are unchanged. No new failures introduced.

If a pre-existing failure changed shape, investigate before proceeding.

- [ ] **Step 2: Manual UI smoke (do not run dev:server — see CLAUDE.md note)**

Inspect the picker rendering by reviewing the diff in `StepPath.jsx` and the test snapshots. The user will run the app themselves to verify visually.

Spot-check by listing the affected paths:

```bash
git diff main --stat -- src/components/upload-config/ src/components/editor/EditorSidebar.jsx src/components/editor/EditorView.jsx src/components/views/ProcessingModal.jsx server/services/auto-orchestrator.js
```

- [ ] **Step 3: Final commit (if any uncommitted bits)**

```bash
git status
```

If clean, the branch is ready to hand back to the user for visual verification.

---

## Risks & Notes

- **Strategy-only resume from rough cut:** Existing infrastructure (`fireResumeFromRoughCut`, `handleResumeFromRoughCut`, `email-notifier paused_at_rough_cut`) was built for guided. We're now firing the same state machine for strategy-only + auto_rough_cut. No new endpoint needed; verify by examining `fireResumeFromRoughCut` once during Task 4 to confirm it doesn't hard-code `path_id === 'guided'` anywhere.
- **Legacy guided projects:** Their picker option is gone, but DB rows with `path_id='guided'` continue to flow through the same orchestrator branches. No migration.
- **Pre-existing 4 test failures:** Two `StepRoughCut` tests (`defaults to Skip`, `shows estimate from server when Run is selected`) may flip outcomes once `autoRoughCut` defaults to `true`. If they break in a new way, that's *expected* and the right fix is updating those tests to match the new default — but only do that as a follow-up; don't bury it in a feature commit.
- **Out of scope:** Removing the `auto_rough_cut` toggle entirely (user chose to keep it), removing the `guided` code paths, removing the `/editor/:id/export` route (still used from non-rough-cut/strategy tabs).
