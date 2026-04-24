# WebApp.2 — XMEML Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the WebApp.2 slice of the b-roll export feature — a pure function (`server/services/xmeml-generator.js`) that produces Adobe Premiere-compatible FCP7 XML (xmeml v5) from variant placement data plus on-disk filenames, plus one Express endpoint (`POST /api/exports/:id/generate-xml`) that wraps that function and is called by the web app **after** the Chrome extension signals download completion. No XML caching, no File System Access API, no client-side XML handling — those belong to WebApp.1. No FCPXML 1.13, no OTIO, no `.prproj` direct generation — those are explicit non-goals per the main spec.

**Architecture:** Single-file pure generator + single new endpoint, both slotted into the Phase 1 backend surface. The generator is 100% deterministic: same inputs → same XML bytes, no I/O, no `Date.now()`, no `Math.random()`. XML is emitted via plain template literals plus a small `escapeXml()` helper — no XML library dependency, because xmeml's shape is simple enough that pulling in `xmlbuilder2`/`fast-xml-parser` would be more code than hand-rolling. The endpoint reuses Phase 1's `requireAuth` middleware (Supabase JWT via `req.auth.userId`), owner-checks the export row, and delegates to `generateXmeml()` once per requested variant. Greedy interval scheduling handles overlapping placements by stacking them onto `V1/V2/V3/...` tracks. Missing metadata defaults to 1920×1080 / 30fps (Premiere re-reads the real values at import anyway). Filename sanitization defense-in-depths the `<NNN>_<source>_<source_item_id>.<ext>` scheme the extension already produces.

**Tech Stack:** Node 20 + Express 5 (existing), `vitest` ^1.0 (NEW devDep, introduced this phase — see "Prerequisites"). No new runtime deps. ES modules, no TypeScript, same as the rest of `server/`.

**Repo note: introducing a test framework.** The project has shipped 20+ services without a test harness (verification has been curl/log/DB driven). The XMEML generator is the first pure-function slice where unit tests are dramatically cheaper than golden-file smoke scripts, and the rest of the extension + web-app work (b-roll queue, telemetry, manifest builder) will want the same harness. This plan introduces `vitest` at Task 1 per the roadmap's open question 7 ("XMEML test strategy — golden-file snapshot tests or proper unit tests; decision point: WebApp.2"). Vitest is picked over Jest because the project already depends on Vite — same ESM runtime, zero config surprises, `"type": "module"` just works.

**Working directory note:** The project path contains a trailing space: `/Users/laurynas/Desktop/one last /transcript-eval/`. Quote every path. Examples in this plan use the shell variable `TE` set at the top of each task.

---

## Why read this before touching code

The generator is deceptively small — ~250 LOC of string assembly — but four properties matter and are easy to silently break.

**1. Pure function discipline.** `generateXmeml()` must be side-effect-free. No `Date.now()`, no `Math.random()`, no `new Date().toISOString()` in the XML (Premiere doesn't read any timestamp fields we'd emit), no filesystem reads, no logging inside the function body. This matters because the function will be called once per variant per export and its output is cached to disk by the web app; any non-determinism turns cache hits into false negatives and makes regression tests flaky. Every test case in Task 5 ends with a "generate twice, assert identical output" check — that assertion is the contract.

**2. Greedy-track algorithm trade-offs.** Overlapping placements go on separate tracks via the greedy-interval-scheduling algorithm in the spec's "Overlapping timeline placements" section: sort by timeline_start_s, assign each clip to the lowest existing track where it doesn't collide, else open a new track. This is greedy and gives a valid (not necessarily minimum) track count. Trade-off: two placements that end/start at the exact same frame boundary are treated as non-overlapping (half-open intervals), which matches Premiere's own behavior when you butt clips against each other. One edge we explicitly DO handle: float precision — `timeline_start_s: 3.0` and `timeline_duration_s: 2.0` must produce an end of exactly 5.0 frames-converted; round at the frame boundary once, not per-comparison.

**3. Filename sanitization rules.** The extension already generates filenames under the scheme `<NNN>_<source>_<source_item_id>.<ext>` (ASCII-clean by construction), but the generator still defends against: reserved chars `<>:"|?*` replaced with `_`; path length cap of 240 chars (Windows MAX_PATH 260 minus margin); ASCII-only (we drop anything outside 0x20–0x7E). This is defensive because (a) future spec changes might let titles leak into filenames and (b) a malformed input shouldn't corrupt the whole XML.

**4. Deterministic output requirement.** FCP7 xmeml is whitespace- and ordering-sensitive when diffed — two semantically identical XMLs with different clip orderings will look different to git, to tests, and to any caching layer. Rules: clips ordered by `seq` (the extension's provisioning sequence, stable across runs); tracks emitted in `V1, V2, V3, ...` order; ids generated as `clip-<variantSlug>-<seq-padded-3>` and `file-<source>-<source_item_id>` (stable, input-derived). No UUIDs, no timestamps, no hash-suffixed names.

**Why we generate AFTER the extension signals complete:** the extension is the only process that knows final on-disk filenames after `conflictAction: "uniquify"` has done its thing (e.g. `002_envato_NX9WYGQ (1).mov` if a collision occurred). The web app collects those final filenames from the extension's `complete` message and passes them into the generator as `placements[].filename`. If we generated earlier, the `<pathurl>` entries might point at files that don't exist on disk. This plan's endpoint reads the resolved filenames from `exports.result_json` (populated by Phase 1's `recordExportEvent({event: 'export_completed'})` flow) — not from `manifest_json`, which holds the pre-run planned filenames.

**Multi-variant dedup contract:** a clip shared across variants A and B lives in `media/` once. Both `variant-a.xml` and `variant-b.xml` reference the same `filename`. The generator NEVER infers dedup — callers pass in placements per-variant, and matching `filename` values across variants happen naturally because the upstream manifest-builder already deduped them. This plan's endpoint loops variants and calls the generator per variant, returning a `{ xml_by_variant: { "A": "...", "B": "..." } }` map.

---

## Scope (WebApp.2 only — hold the line)

### In scope

- `server/services/xmeml-generator.js` — pure function `generateXmeml({ sequenceName, placements, frameRate, sequenceSize }) → xmlString` plus an internal `escapeXml()` helper.
- Unit tests with `vitest` covering single/multiple placements, overlap, missing metadata, filename sanitization, determinism, and the empty-placements edge case.
- Golden fixture files under `server/services/__tests__/__fixtures__/xmeml/` so diffing regressions is a one-line assertion.
- `server/routes/export-xml.js` — `POST /api/exports/:id/generate-xml` returning `{ xml_by_variant: { "A": "<xml>", ... } }`. Bearer JWT via `requireAuth`; owner-checked against `req.auth.userId`.
- `server/routes/exports.js` extension: add `GET /api/exports/:id` (status lookup) **iff** it's not already present on the branch we merge onto — it's referenced by the spec and consumed by this plan's endpoint via `getExport(id, { userId })` at the service layer. If present, reuse.
- `server/services/exports.js` extension: add `getExportResult(id)` (reads the post-run per-item result, including resolved filenames, from `exports.result_json`).
- `server/index.js` — wire new router.
- `package.json` — devDep `vitest`, scripts `test` / `test:watch`.

### Deferred (DO NOT add to WebApp.2 — they belong to later phases or are non-goals)

- **No FCPXML 1.13.** Final Cut Pro 11 compatibility is listed in the spec's "Known future work" — separate generator, same placement data, different schema. Don't implement.
- **No OTIO export.** Resolve-native interchange is noted in "Known future work"; FCP7 xmeml is today's only format.
- **No `.prproj` direct generation.** Adobe binary format, no public spec; explicit spec non-goal.
- **No UTF-8 in filenames.** The sanitizer drops non-ASCII bytes. If future work needs international titles in filenames, that's a separate filename-scheme RFC.
- **No `<audio>` tracks.** The spec's template shows `<video>` only; audio metadata isn't present in the manifest today. If a future upstream change adds `audio_sample_rate` / `audio_channels` per clip, emit then. DO NOT silently fabricate defaults.
- **No File System Access API / disk writes.** The endpoint returns XML strings as JSON; WebApp.1 handles saving them to the user's target folder alongside `media/`.
- **No partial-run XML logic in the generator.** If `placements` is empty, the function's behavior is explicit (see Task 4). Whether a partial run SHOULD generate XML at all is a WebApp.1 / State F decision — the generator just renders whatever it's given.
- **No in-function preview-vs-source resolution logic.** The spec flags that source files may differ from preview; this is a user-education issue (tooltip in editor), not a generator concern. We emit whatever width/height the caller provides.
- **No XML validation against a schema.** Premiere accepts a very permissive subset; we target that subset. If Premiere rejects an output, add a targeted test fixture for the failing shape; don't add an XSD.
- **No caching, no compression, no streaming.** Endpoint returns inline JSON. At ~50 clips, XML is <20 KB; no reason to stream.
- **No admin-UI hook.** Phase 9 (WebApp.3) adds `/admin/exports` visibility.

Fight the urge to "just add" any of the above. WebApp.2 ships the emission path; WebApp.1 owns user-visible XML handling; other NLE formats are entirely separate plans.

---

## Prerequisites

- Node 20+ (already used by transcript-eval).
- Phase 1 backend branch merged OR worktree branched off `feature/envato-export-phase1` — this plan references `requireAuth`, `server/services/exports.js`, and the `exports`/`export_events` tables from Phase 1. If Phase 1 is unmerged, branch this plan off `feature/envato-export-phase1` rather than `main`.
- **Test framework: `vitest`.** This phase introduces the project's first test harness. Per the roadmap's "Decisions — still open #2" + "#7": XMEML's pure-function shape is the cheapest first case, and extension modules will want the same harness next. Choice justification:
  - **Vitest over Jest:** project already depends on Vite (^8.0.0); vitest shares Vite's ESM runtime with zero extra config for `"type": "module"`. Jest + ESM still requires babel/ts-jest boilerplate.
  - **Vitest over Mocha/Chai:** batteries-included (assertions + runner + coverage via `@vitest/coverage-v8`), single devDep, no plugin matrix.
  - **Vitest over Node's built-in `node:test`:** similar capability but Vitest's `expect`/`toMatchSnapshot` API is more ergonomic for the XML golden-file style, and getting watch mode right on `node:test` is awkward.
- No change to existing `dev:server`/`dev:client` scripts. `npm run test` / `npm run test:watch` are additive.
- Path to the repo has a trailing space in `one last ` — quote every path.

---

## File structure (final state)

All paths are inside the transcript-eval repo root (`$TE`).

```
$TE/server/
├── index.js                                      (modified: +1 import, +1 app.use)
├── routes/
│   └── export-xml.js                             NEW — POST /api/exports/:id/generate-xml
├── services/
│   ├── exports.js                                (modified: +getExportResult helper)
│   ├── xmeml-generator.js                        NEW — pure generateXmeml() + escapeXml()
│   └── __tests__/
│       ├── xmeml-generator.test.js               NEW — 7 test cases (Task 5)
│       └── __fixtures__/
│           └── xmeml/
│               ├── single-placement.xml          golden: Case 1
│               ├── two-non-overlapping.xml       golden: Case 2
│               ├── three-overlapping.xml         golden: Case 3
│               └── missing-metadata.xml          golden: Case 4

$TE/package.json                                  (modified: +vitest devDep, +test scripts)
$TE/vitest.config.js                              NEW — minimal config, node environment
$TE/docs/superpowers/plans/
└── 2026-04-24-webapp-xmeml-generator.md          THIS FILE
```

Why this split:
- `xmeml-generator.js` is the only file that knows FCP7 xmeml syntax. Keep it away from Express/DB — the route is a 30-line adapter.
- `__tests__/` is a sibling of the service, not a peer of `server/services/`, so the folder collocation makes it obvious which file a test targets.
- `__fixtures__/xmeml/` is the golden-file directory. Each fixture is committed; test authors regenerate them via `vitest -u` (snapshot-update) when XML format intentionally changes.
- `vitest.config.js` at the repo root (not inside `server/`) because future frontend unit tests (hooks under `src/`) will share the same config if/when added.
- `export-xml.js` gets its own route file instead of appending to `exports.js` because the XML concern is orthogonal to the Phase 1 CRUD concern, and because the Phase 1 `exports.js` already has 5 routers exported from one file — one more would start to be crowded.

---

## Working conventions for these tasks

- **Worktree:** All work happens in `$TE/.worktrees/xmeml-generator` on branch `feature/xmeml-generator`, branched off `main` (or off `feature/envato-export-phase1` if Phase 1 hasn't merged yet). The worktree skill `superpowers:using-git-worktrees` should be invoked at Task 0.
- **Never push.** `git commit` is fine. `git push` requires explicit user approval and is NOT part of this plan. Task 8 makes this explicit.
- **Commit style:** conventional commits (`feat(xml): ...`, `test(xml): ...`, `chore(test): ...`). Multi-line body OK. Add the Claude co-author trailer to every commit:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Quote paths with the trailing space.** `cd "/Users/laurynas/Desktop/one last /transcript-eval/"` — the space in `one last ` is load-bearing.
- **Never kill process on port 3001.** That's the user's backend dev server. Tests don't need a running server; they call the pure function directly.
- **Endpoint auth is non-negotiable.** The endpoint MUST require `requireAuth` and MUST owner-check the export against `req.auth.userId`. A user requesting XML for an export they don't own returns 404, collapsing missing-vs-not-owned the same way Phase 1 does for `recordExportEvent` (prevents enumeration oracle).

---

## Task 0: Create worktree + vitest devDep + config

**Files:**
- Create: `$TE/.worktrees/xmeml-generator/` (worktree)
- Modify: `$TE/.worktrees/xmeml-generator/package.json` (add `vitest`, scripts)
- Create: `$TE/.worktrees/xmeml-generator/vitest.config.js`

- [ ] **Step 1: Create the worktree + branch**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
git fetch origin main
# Branch off main. If Phase 1 is still unmerged, substitute
# `feature/envato-export-phase1` for `main` below and re-verify in Step 2.
git worktree add -b feature/xmeml-generator .worktrees/xmeml-generator main
cd ".worktrees/xmeml-generator"
pwd
# Expected: /Users/laurynas/Desktop/one last /transcript-eval/.worktrees/xmeml-generator
git status
# Expected: "On branch feature/xmeml-generator; nothing to commit, working tree clean"
```

- [ ] **Step 2: Verify you are on the new branch before any file changes**

```bash
git branch --show-current
# Expected: feature/xmeml-generator
```

If this prints anything else, STOP and fix — don't write files into the wrong branch.

- [ ] **Step 3: Confirm Phase 1 exports service is reachable (branch sanity)**

```bash
test -f server/services/exports.js && echo "EXPORTS_PRESENT" || echo "EXPORTS_MISSING"
# Expected: EXPORTS_PRESENT
#
# If EXPORTS_MISSING, you branched off main before Phase 1 merged. Fix:
#   git worktree remove .worktrees/xmeml-generator --force
#   git worktree add -b feature/xmeml-generator .worktrees/xmeml-generator feature/envato-export-phase1
```

- [ ] **Step 4: Install vitest as devDep**

```bash
npm install --save-dev vitest@^1.6.0
# Expected: package.json gets "vitest" in devDependencies; node_modules/vitest/ exists.
```

- [ ] **Step 5: Add `test` and `test:watch` scripts to `package.json`**

Read the current `scripts` block and extend it. Use Edit with the full existing block to avoid accidental whitespace drift.

`old_string`:
```
    "seed:strategies": "node server/seed/create-strategies.js"
  },
```

`new_string`:
```
    "seed:strategies": "node server/seed/create-strategies.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
```

Re-read `package.json` after the edit to confirm JSON is valid.

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && echo OK
# Expected: OK
```

- [ ] **Step 6: Create `vitest.config.js` at the repo root**

```js
// Vitest config for transcript-eval. First test harness in the project
// — kept minimal. Tests live next to the code they test, under a
// __tests__/ directory, to match the server/services/__tests__/ pattern
// established by WebApp.2.

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',        // server-side code; no DOM
    include: ['server/**/__tests__/**/*.test.js'],
    globals: false,             // explicit imports of describe/it/expect
    reporters: 'default',
    watch: false,               // `npm run test:watch` opts in
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['server/services/**/*.js'],
      exclude: ['server/services/__tests__/**', 'server/services/*.py'],
    },
  },
})
```

- [ ] **Step 7: Sanity-run vitest with no tests yet**

```bash
npx vitest run --passWithNoTests 2>&1 | tail -10
# Expected: a "No test files found" line, exit 0.
# (Without the flag, vitest exits non-zero when no tests exist.)
```

If vitest errors with a "Cannot find module" for vitest itself, `npm install` didn't finish — rerun Step 4.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vitest.config.js
git status --short
# Expected: 3 files staged; no other changes.
git commit -m "$(cat <<'EOF'
chore(test): introduce vitest as the project test framework

First unit-test harness in transcript-eval. Picks vitest because the
project already depends on Vite — same ESM runtime, zero config
surprises for "type": "module" ESM.

Scoped to server/**/__tests__/**/*.test.js so frontend files under
src/ stay untouched until we add frontend unit tests separately.

WebApp.2's XMEML generator is the first consumer (next commit);
future extension modules + manifest builder will reuse.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git log --oneline -1
# Expected: <sha> chore(test): introduce vitest as the project test framework
```

---

## Task 1: `escapeXml()` helper + stub module

Ship the helper first, alone, with its own targeted tests. It's a 5-line function but a load-bearing correctness primitive — every `<name>` / `<pathurl>` text node in the generator passes through it.

**Files:**
- Create: `$TE/.worktrees/xmeml-generator/server/services/xmeml-generator.js` (stub with only `escapeXml`)
- Create: `$TE/.worktrees/xmeml-generator/server/services/__tests__/xmeml-generator.test.js` (escapeXml tests only for now)

- [ ] **Step 1: Write the stub module**

Create `server/services/xmeml-generator.js` with just the helper and an explicit TODO for `generateXmeml`:

```js
// XMEML generator — FCP7 xmeml v5 emitter for Adobe Premiere import.
//
// Pure function. No I/O, no Date.now(), no Math.random(). Same inputs
// always produce byte-identical output. See
// docs/specs/2026-04-23-envato-export-design.md § "XMEML generation"
// for the target format and
// docs/superpowers/plans/2026-04-24-webapp-xmeml-generator.md for the
// task-by-task breakdown of how the pieces fit.
//
// Time conversion: XMEML time fields (`<start>`, `<end>`, `<in>`,
// `<out>`, `<duration>`) are in FRAMES, not seconds. The generator
// converts via `frame = Math.round(timelineSeconds * frameRate)` at a
// single boundary (before emission); all comparisons and arithmetic
// after that point are integer-frame.

// ----------------------------------------------------------------------
// escapeXml — XML 1.0 text-node / attribute-safe escape.
//
// Covers the 5 reserved chars: &, <, >, ", '. Handles them in a single
// replace via a char-class regex (don't special-case & first; that
// requires careful ordering and is a classic source of double-escape
// bugs). Non-ASCII control chars are dropped by the filename
// sanitizer, so we don't need to emit numeric character references
// (&#NN;) here.
export function escapeXml(input) {
  if (input === null || input === undefined) return ''
  const s = String(input)
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&apos;'
      default:  return c
    }
  })
}

// TODO(task 2+): generateXmeml(...) — implemented in subsequent tasks.
export function generateXmeml() {
  throw new Error('generateXmeml: not yet implemented — see task 2')
}
```

- [ ] **Step 2: Write the `escapeXml` test cases**

Create `server/services/__tests__/xmeml-generator.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { escapeXml } from '../xmeml-generator.js'

describe('escapeXml', () => {
  it('passes plain ASCII through unchanged', () => {
    expect(escapeXml('hello world')).toBe('hello world')
    expect(escapeXml('001_envato_NX9WYGQ.mov')).toBe('001_envato_NX9WYGQ.mov')
  })

  it('escapes the five XML reserved chars', () => {
    expect(escapeXml('<tag>')).toBe('&lt;tag&gt;')
    expect(escapeXml('Tom & Jerry')).toBe('Tom &amp; Jerry')
    expect(escapeXml(`she said "hi"`)).toBe('she said &quot;hi&quot;')
    expect(escapeXml(`it's fine`)).toBe('it&apos;s fine')
  })

  it('does not double-escape already-escaped entities', () => {
    // This is the subtle bug: naive sequential .replace would turn
    // "&amp;" into "&amp;amp;" if & is processed before <. Our regex
    // fires one replacement per char position, so we're safe.
    expect(escapeXml('&amp;')).toBe('&amp;amp;')
    // NB: the correct behavior for an input that happens to already
    // look escaped IS to re-escape — the input is a raw string, not
    // pre-escaped XML. The assertion above is intentional.
  })

  it('handles null/undefined gracefully', () => {
    expect(escapeXml(null)).toBe('')
    expect(escapeXml(undefined)).toBe('')
  })

  it('coerces non-strings via String()', () => {
    expect(escapeXml(42)).toBe('42')
    expect(escapeXml(true)).toBe('true')
  })
})

describe('generateXmeml (stub)', () => {
  it('throws the not-yet-implemented error', () => {
    // Confirms the stub is wired up. Real tests arrive in Task 5.
    // TODO(task 2-5): replace with real behavior.
    // Using a try/catch so we can assert message text explicitly.
    // eslint-disable-next-line no-undef — describe/it from vitest import
    let thrown
    try {
      require('../xmeml-generator.js').generateXmeml({})
    } catch (e) {
      thrown = e
    }
    // Note: we can't use require() in an ESM module — rewrite to import.
  })
})
```

Wait — the `generateXmeml (stub)` test as written uses `require()` which isn't valid in ESM. Rewrite that block:

```js
describe('generateXmeml (stub)', () => {
  it('throws the not-yet-implemented error', async () => {
    const { generateXmeml } = await import('../xmeml-generator.js')
    expect(() => generateXmeml({})).toThrow(/not yet implemented/)
  })
})
```

- [ ] **Step 3: Run the tests**

```bash
npm test 2>&1 | tail -15
```

Expected output ends with:
```
Test Files  1 passed (1)
     Tests  6 passed (6)
```

If any test fails, fix `xmeml-generator.js` — don't loosen the assertion.

- [ ] **Step 4: Commit**

```bash
git add server/services/xmeml-generator.js server/services/__tests__/xmeml-generator.test.js
git commit -m "$(cat <<'EOF'
feat(xml): escapeXml helper + stub module for XMEML generator

Single-regex escape of XML reserved chars (&, <, >, ", ') in one
pass. Null/undefined coalesce to empty string. Non-string inputs
are String()-coerced — we never throw from escaping; a malformed
input becomes malformed output, caught downstream by test
assertions on golden fixtures.

generateXmeml() itself is stubbed as a not-yet-implemented throw
so Task 2 can land the real body as a pure additive change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Filename sanitizer + time conversion + `getTrackAssignments()`

Three tightly-related primitives that the main generator function composes. Each gets its own unit tests so a regression lands with a pointed failure, not a 400-line XML diff.

**Files:**
- Modify: `$TE/.worktrees/xmeml-generator/server/services/xmeml-generator.js`
- Modify: `$TE/.worktrees/xmeml-generator/server/services/__tests__/xmeml-generator.test.js`

- [ ] **Step 1: Add sanitizer + time converter + track-assignment to the generator**

Append to `server/services/xmeml-generator.js` (above the `generateXmeml` stub, below `escapeXml`):

```js
// ----------------------------------------------------------------------
// sanitizeFilename — defensive ASCII-only + reserved-char replacement.
//
// The extension already emits names like "001_envato_NX9WYGQ.mov" which
// are ASCII-clean by construction, but we apply the spec's rules here
// as belt-and-suspenders:
//
//   - Drop any byte outside printable ASCII (0x20–0x7E).
//   - Replace Windows-reserved chars <>:"|?* with _.
//   - Preserve / to allow subpath components (we only emit leaf names,
//     but this keeps the primitive general-purpose).
//   - Cap total length at 240 chars (Windows MAX_PATH 260 minus margin).
//
// NOT responsible for: generating the name (extension does that),
// checking for collisions (`chrome.downloads` handles via
// `conflictAction: "uniquify"`), or lowercasing (Premiere is
// case-sensitive on Linux/macOS).
const RESERVED_CHARS = /[<>:"|?*]/g
const NON_PRINTABLE_ASCII = /[^\x20-\x7E]/g
const MAX_PATH_LEN = 240

export function sanitizeFilename(name) {
  if (name === null || name === undefined) return ''
  let s = String(name)
  s = s.replace(NON_PRINTABLE_ASCII, '')
  s = s.replace(RESERVED_CHARS, '_')
  if (s.length > MAX_PATH_LEN) s = s.slice(0, MAX_PATH_LEN)
  return s
}

// ----------------------------------------------------------------------
// secondsToFrames — single rounding boundary for timeline arithmetic.
//
// All XMEML time fields are integer frames. Round once here; downstream
// code compares integers. Using Math.round() (not floor/ceil) matches
// Premiere's own behavior when it reads float-second timelines.
export function secondsToFrames(seconds, frameRate) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    throw new Error(`secondsToFrames: seconds must be a finite number, got ${seconds}`)
  }
  if (typeof frameRate !== 'number' || !Number.isFinite(frameRate) || frameRate <= 0) {
    throw new Error(`secondsToFrames: frameRate must be a positive finite number, got ${frameRate}`)
  }
  return Math.round(seconds * frameRate)
}

// ----------------------------------------------------------------------
// assignTracks — greedy interval scheduling.
//
// Input: placements with integer-frame start/end (after secondsToFrames).
// Output: same placements, each annotated with .trackIndex (0-based: V1 = 0).
//
// Algorithm (spec § "Overlapping timeline placements"):
//   1. Sort by start frame ascending; ties broken by seq (stable).
//   2. Track frontier = array of "next-free frame" per track index.
//   3. For each placement, find the lowest track index whose frontier
//      is ≤ this placement's start. If none, open a new track.
//   4. Update that track's frontier to this placement's end.
//
// Half-open intervals: a clip ending at frame 120 and another starting
// at frame 120 share track — matches Premiere's butt-splice semantics.
// This is the right call; XMEML placements at shared frame boundaries
// are idiomatic.
export function assignTracks(placements) {
  // Copy + sort so we don't mutate caller's array.
  const sorted = placements
    .map((p, originalIndex) => ({ ...p, _originalIndex: originalIndex }))
    .sort((a, b) => {
      if (a._startFrame !== b._startFrame) return a._startFrame - b._startFrame
      // Tiebreak on seq so ordering is deterministic across runs.
      return a.seq - b.seq
    })

  const frontier = []  // frontier[i] = next-free frame on track i

  for (const p of sorted) {
    let assigned = -1
    for (let i = 0; i < frontier.length; i++) {
      if (frontier[i] <= p._startFrame) {
        assigned = i
        break
      }
    }
    if (assigned === -1) {
      frontier.push(p._endFrame)
      p.trackIndex = frontier.length - 1
    } else {
      frontier[assigned] = p._endFrame
      p.trackIndex = assigned
    }
  }

  // Restore original seq-based ordering? No — callers get the
  // sorted-by-start ordering, which is what XMEML emission wants
  // (we emit per-track, but per-track ordering is also by start).
  // _originalIndex is left in place for debuggability; callers may
  // strip before emission.
  return sorted
}
```

- [ ] **Step 2: Extend the test file**

Append to `server/services/__tests__/xmeml-generator.test.js`:

```js
import { sanitizeFilename, secondsToFrames, assignTracks } from '../xmeml-generator.js'

describe('sanitizeFilename', () => {
  it('passes through safe ASCII names', () => {
    expect(sanitizeFilename('001_envato_NX9WYGQ.mov')).toBe('001_envato_NX9WYGQ.mov')
    expect(sanitizeFilename('002_pexels_456.mp4')).toBe('002_pexels_456.mp4')
  })

  it('replaces Windows-reserved chars with _', () => {
    expect(sanitizeFilename('bad<name>.mov')).toBe('bad_name_.mov')
    expect(sanitizeFilename('a:b|c?d*.mp4')).toBe('a_b_c_d_.mp4')
    expect(sanitizeFilename('with"quote.mov')).toBe('with_quote.mov')
  })

  it('drops non-printable ASCII and unicode', () => {
    expect(sanitizeFilename('café.mov')).toBe('caf.mov')           // é dropped
    expect(sanitizeFilename('tab\there.mov')).toBe('tabhere.mov')  // \t dropped
    expect(sanitizeFilename('日本語.mp4')).toBe('.mp4')
  })

  it('caps length at 240 chars', () => {
    const long = 'x'.repeat(500)
    const out = sanitizeFilename(long)
    expect(out.length).toBe(240)
    expect(out).toBe('x'.repeat(240))
  })

  it('handles null/undefined/empty as empty string', () => {
    expect(sanitizeFilename(null)).toBe('')
    expect(sanitizeFilename(undefined)).toBe('')
    expect(sanitizeFilename('')).toBe('')
  })
})

describe('secondsToFrames', () => {
  it('converts exact boundaries', () => {
    expect(secondsToFrames(0, 30)).toBe(0)
    expect(secondsToFrames(1, 30)).toBe(30)
    expect(secondsToFrames(2.5, 30)).toBe(75)
  })

  it('rounds to nearest frame (banker-style not needed, Math.round)', () => {
    expect(secondsToFrames(0.016666, 30)).toBe(0)   // < 0.5 frame
    expect(secondsToFrames(0.017, 30)).toBe(1)      // > 0.5 frame
    expect(secondsToFrames(1.0 / 60, 60)).toBe(1)   // exact 1 frame at 60fps
  })

  it('throws on non-finite or non-positive inputs', () => {
    expect(() => secondsToFrames(NaN, 30)).toThrow()
    expect(() => secondsToFrames(0, 0)).toThrow()
    expect(() => secondsToFrames(0, -30)).toThrow()
    expect(() => secondsToFrames('1', 30)).toThrow()
  })
})

describe('assignTracks', () => {
  // Helpers: construct a placement with integer frames pre-computed.
  const p = (seq, startFrame, endFrame) => ({
    seq, _startFrame: startFrame, _endFrame: endFrame,
  })

  it('assigns single placement to V1 (index 0)', () => {
    const out = assignTracks([p(1, 0, 60)])
    expect(out[0].trackIndex).toBe(0)
  })

  it('keeps two non-overlapping placements on V1', () => {
    const out = assignTracks([p(1, 0, 60), p(2, 60, 120)])  // butt-splice
    expect(out.map(x => x.trackIndex)).toEqual([0, 0])

    const out2 = assignTracks([p(1, 0, 60), p(2, 90, 150)]) // gap
    expect(out2.map(x => x.trackIndex)).toEqual([0, 0])
  })

  it('stacks three overlapping placements across V1/V2/V3', () => {
    // All three overlap at frame 30.
    const out = assignTracks([
      p(1, 0, 60),
      p(2, 10, 70),
      p(3, 20, 80),
    ])
    // After sort by start: [1, 2, 3] already.
    expect(out.map(x => ({ seq: x.seq, t: x.trackIndex }))).toEqual([
      { seq: 1, t: 0 },
      { seq: 2, t: 1 },
      { seq: 3, t: 2 },
    ])
  })

  it('reuses a track when a prior clip has ended', () => {
    // p1 ends at 60, p3 starts at 70 — p3 goes on V1 not V3.
    const out = assignTracks([
      p(1, 0, 60),
      p(2, 10, 100),  // opens V2
      p(3, 70, 120),  // should reuse V1 (60 ≤ 70)
    ])
    expect(out.map(x => ({ seq: x.seq, t: x.trackIndex }))).toEqual([
      { seq: 1, t: 0 },
      { seq: 2, t: 1 },
      { seq: 3, t: 0 },
    ])
  })

  it('breaks start-time ties by seq (deterministic)', () => {
    const out = assignTracks([
      p(2, 0, 60),
      p(1, 0, 60),
    ])
    // Sort by start=0 both → seq tiebreak → p1 before p2.
    // Both start at 0 and overlap → V1 and V2.
    expect(out.map(x => ({ seq: x.seq, t: x.trackIndex }))).toEqual([
      { seq: 1, t: 0 },
      { seq: 2, t: 1 },
    ])
  })
})
```

- [ ] **Step 3: Run the tests**

```bash
npm test 2>&1 | tail -20
```

Expected: `Test Files  1 passed (1)` and `Tests  XX passed (XX)` where XX = 6 (escapeXml + stub) + 5 (sanitizeFilename) + 3 (secondsToFrames) + 5 (assignTracks) = 19.

If any `assignTracks` test fails, the greedy algorithm has drifted — fix the function, don't loosen the assertion.

- [ ] **Step 4: Commit**

```bash
git add server/services/xmeml-generator.js server/services/__tests__/xmeml-generator.test.js
git commit -m "$(cat <<'EOF'
feat(xml): filename sanitizer, seconds→frames, track assignment

Three pure primitives that the generateXmeml() body composes in the
next task. Each has targeted unit tests so regressions land with a
pointed failure rather than a 400-line XML diff.

- sanitizeFilename: ASCII-only, <>:"|?* → _, length cap 240.
- secondsToFrames: Math.round at a single boundary; throws on
  non-finite or non-positive inputs (fail fast, don't emit NaN).
- assignTracks: greedy interval scheduling; half-open intervals so
  butt-splices share a track; deterministic seq tiebreak on
  identical start frames.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `generateXmeml()` — the main function

Compose the primitives into the real XML emitter. The function is a large template literal, but the logic is minimal: sort/assign tracks, group by track, emit per-track `<clipitem>` elements, wrap in the sequence chrome.

**Files:**
- Modify: `$TE/.worktrees/xmeml-generator/server/services/xmeml-generator.js`

- [ ] **Step 1: Replace the `generateXmeml` stub with the real implementation**

Use Edit. `old_string` is the stub:

```
// TODO(task 2+): generateXmeml(...) — implemented in subsequent tasks.
export function generateXmeml() {
  throw new Error('generateXmeml: not yet implemented — see task 2')
}
```

`new_string` (full implementation):

```
// ----------------------------------------------------------------------
// generateXmeml — main entry point.
//
// Inputs:
//   sequenceName: string  — human-readable, e.g. "Variant C". Escaped.
//   placements: Array<{
//     seq: number                — monotonic; used for ids + ordering
//     source: string             — "envato" | "pexels" | "freepik"
//     sourceItemId: string       — upstream id; used in file id
//     filename: string           — leaf name in media/; sanitized
//     timelineStart: number      — seconds on timeline
//     timelineDuration: number   — seconds
//     width?: number             — per-file, defaults to sequenceSize.w
//     height?: number            — per-file, defaults to sequenceSize.h
//     sourceFrameRate?: number   — per-file, defaults to frameRate
//   }>
//   frameRate: number = 30       — sequence timebase
//   sequenceSize: {w, h} = 1920x1080
//
// Returns: XML string (FCP7 xmeml v5). Deterministic: same inputs →
// byte-identical output across calls and processes.
//
// Edge cases:
//   - placements is empty → emit a valid <sequence> with an empty
//     <video> (one track, no clipitems). Does NOT throw — the caller
//     decides whether to offer XML for a zero-item run.
//   - missing width/height/sourceFrameRate on a placement → use
//     sequence defaults. Premiere re-reads actual file metadata on
//     import anyway.
//   - overlapping placements → stacked on V1/V2/... via assignTracks.
//   - escapes every text node that could contain user-influenced
//     data (sequenceName, filename, file id components).
//
// What the function is NOT:
//   - Not a file writer. Returns a string.
//   - Not a validator against an XMEML schema. We target the permissive
//     subset Premiere accepts; regressions are caught by golden fixture
//     tests in Task 5.

function slugifyForId(input) {
  // Deterministic id segment: ASCII alphanumerics + dashes. Anything
  // else becomes -. Used for <clipitem id> and <file id> — these are
  // XML attribute values, which don't need escaping for our allowed
  // char set, but sanitizing avoids `"` or other terminator issues.
  return String(input || '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
}

function padSeq(seq) {
  const s = String(seq)
  return s.length >= 3 ? s : ('000' + s).slice(-3)
}

export function generateXmeml({
  sequenceName,
  placements,
  frameRate = 30,
  sequenceSize = { w: 1920, h: 1080 },
}) {
  if (typeof sequenceName !== 'string' || !sequenceName) {
    throw new Error('generateXmeml: sequenceName must be a non-empty string')
  }
  if (!Array.isArray(placements)) {
    throw new Error('generateXmeml: placements must be an array')
  }
  if (typeof frameRate !== 'number' || !Number.isFinite(frameRate) || frameRate <= 0) {
    throw new Error('generateXmeml: frameRate must be a positive finite number')
  }
  const seqW = sequenceSize?.w ?? 1920
  const seqH = sequenceSize?.h ?? 1080
  if (!Number.isFinite(seqW) || !Number.isFinite(seqH) || seqW <= 0 || seqH <= 0) {
    throw new Error('generateXmeml: sequenceSize.{w,h} must be positive finite numbers')
  }

  const seqSlug = slugifyForId(sequenceName).toLowerCase() || 'seq'

  // Step 1: normalize each placement — integer frames, defaulted metadata,
  // sanitized filenames.
  const normalized = placements.map((p) => {
    if (!p || typeof p !== 'object') {
      throw new Error('generateXmeml: each placement must be an object')
    }
    if (typeof p.seq !== 'number' || !Number.isFinite(p.seq)) {
      throw new Error(`generateXmeml: placement missing numeric seq (got ${p.seq})`)
    }
    if (typeof p.filename !== 'string' || !p.filename) {
      throw new Error(`generateXmeml: placement seq=${p.seq} missing filename`)
    }
    const startFrame = secondsToFrames(p.timelineStart, frameRate)
    const duration = secondsToFrames(p.timelineDuration, frameRate)
    const endFrame = startFrame + duration
    const width = Number.isFinite(p.width) && p.width > 0 ? p.width : seqW
    const height = Number.isFinite(p.height) && p.height > 0 ? p.height : seqH
    const sourceFrameRate = Number.isFinite(p.sourceFrameRate) && p.sourceFrameRate > 0
      ? p.sourceFrameRate : frameRate
    const cleanName = sanitizeFilename(p.filename)
    return {
      seq: p.seq,
      source: p.source || '',
      sourceItemId: p.sourceItemId || '',
      filename: cleanName,
      _startFrame: startFrame,
      _endFrame: endFrame,
      _duration: duration,
      _width: width,
      _height: height,
      _sourceFrameRate: sourceFrameRate,
    }
  })

  // Step 2: assign tracks (no-op if placements is empty).
  const withTracks = assignTracks(normalized)

  // Step 3: group by track index. Within each track, order by start
  // frame (already done by assignTracks).
  const tracksByIndex = new Map()
  for (const p of withTracks) {
    if (!tracksByIndex.has(p.trackIndex)) tracksByIndex.set(p.trackIndex, [])
    tracksByIndex.get(p.trackIndex).push(p)
  }

  // Step 4: sequence <duration> = last end frame across all tracks.
  // Zero if no placements.
  let sequenceDuration = 0
  for (const p of withTracks) {
    if (p._endFrame > sequenceDuration) sequenceDuration = p._endFrame
  }

  // Step 5: emit. String concatenation in a single pass — no intermediate
  // arrays, no DOM builder. 2-space indent to match the spec's example.
  const lines = []
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`)
  lines.push(`<!DOCTYPE xmeml>`)
  lines.push(`<xmeml version="5">`)
  lines.push(`  <sequence id="seq-${slugifyForId(seqSlug)}">`)
  lines.push(`    <name>${escapeXml(sequenceName)}</name>`)
  lines.push(`    <duration>${sequenceDuration}</duration>`)
  lines.push(`    <rate><timebase>${frameRate}</timebase><ntsc>FALSE</ntsc></rate>`)
  lines.push(`    <media>`)
  lines.push(`      <video>`)
  lines.push(`        <format>`)
  lines.push(`          <samplecharacteristics>`)
  lines.push(`            <width>${seqW}</width><height>${seqH}</height>`)
  lines.push(`            <rate><timebase>${frameRate}</timebase></rate>`)
  lines.push(`          </samplecharacteristics>`)
  lines.push(`        </format>`)

  // Emit tracks in V1, V2, V3 order. If placements is empty, emit zero
  // tracks inside <video> — valid xmeml, opens in Premiere as an empty
  // video layer.
  const trackIndices = Array.from(tracksByIndex.keys()).sort((a, b) => a - b)
  for (const trackIdx of trackIndices) {
    lines.push(`        <track>`)
    for (const p of tracksByIndex.get(trackIdx)) {
      const clipId = `clip-${seqSlug}-${padSeq(p.seq)}`
      const fileId = `file-${slugifyForId(p.source)}-${slugifyForId(p.sourceItemId) || padSeq(p.seq)}`
      lines.push(`          <clipitem id="${escapeXml(clipId)}">`)
      lines.push(`            <name>${escapeXml(p.filename)}</name>`)
      lines.push(`            <start>${p._startFrame}</start>`)
      lines.push(`            <end>${p._endFrame}</end>`)
      lines.push(`            <in>0</in>`)
      lines.push(`            <out>${p._duration}</out>`)
      lines.push(`            <file id="${escapeXml(fileId)}">`)
      lines.push(`              <name>${escapeXml(p.filename)}</name>`)
      lines.push(`              <pathurl>file://./media/${escapeXml(p.filename)}</pathurl>`)
      lines.push(`              <duration>${p._duration}</duration>`)
      lines.push(`              <rate><timebase>${p._sourceFrameRate}</timebase></rate>`)
      lines.push(`              <media>`)
      lines.push(`                <video><samplecharacteristics>`)
      lines.push(`                  <width>${p._width}</width><height>${p._height}</height>`)
      lines.push(`                </samplecharacteristics></video>`)
      lines.push(`              </media>`)
      lines.push(`            </file>`)
      lines.push(`          </clipitem>`)
    }
    lines.push(`        </track>`)
  }

  lines.push(`      </video>`)
  lines.push(`    </media>`)
  lines.push(`  </sequence>`)
  lines.push(`</xmeml>`)
  lines.push(``)  // trailing newline

  return lines.join('\n')
}
```

Note: the stub `export function generateXmeml()` at the bottom of the file must be replaced, not appended. Use `replace_all: false` (default) — the stub is unique.

- [ ] **Step 2: Sanity-check with a hand-run**

```bash
node -e '
import("./server/services/xmeml-generator.js").then(({ generateXmeml }) => {
  const xml = generateXmeml({
    sequenceName: "Variant C",
    placements: [
      { seq: 1, source: "envato", sourceItemId: "NX9WYGQ",
        filename: "001_envato_NX9WYGQ.mov",
        timelineStart: 25.4, timelineDuration: 4.0,
        width: 1920, height: 1080, sourceFrameRate: 30 },
    ],
  });
  console.log(xml);
});
'
```

Expected: a well-formed xmeml document with one `<track>` containing one `<clipitem>`, `<start>762</start>`, `<end>882</end>` (25.4*30=762, 4.0*30=120, 762+120=882). This matches the spec's template exactly.

- [ ] **Step 3: Confirm existing tests still pass**

```bash
npm test 2>&1 | tail -10
```

Expected: all 19 tests still pass. The stub test from Task 1 no longer matches (the throw message changed), so re-check — if it fails, that test asserted "not yet implemented" which is now gone. Remove that stub test from the test file.

Use Edit to delete the `describe('generateXmeml (stub)', ...)` block and its contents — it's now obsolete. Task 5 will reintroduce real `generateXmeml` tests.

- [ ] **Step 4: Commit**

```bash
git add server/services/xmeml-generator.js server/services/__tests__/xmeml-generator.test.js
git commit -m "$(cat <<'EOF'
feat(xml): generateXmeml — pure FCP7 xmeml emitter

Composes escapeXml + sanitizeFilename + secondsToFrames + assignTracks
into the main entry point. ~120 LOC of template-literal concatenation,
no XML library.

Guarantees:
- Pure: no Date.now, no Math.random, no I/O. Same inputs → byte-
  identical output.
- Deterministic ids: clip-<slug>-<seq3>, file-<source>-<itemid>.
- Missing metadata falls back to sequence-level defaults (1920x1080,
  30fps per call sig).
- Empty placements → valid empty <sequence> (no throw; caller decides).
- All text nodes + attribute values pass through escapeXml — defends
  against any future manifest change that leaks unsanitized strings.

Stub throw-test from Task 1 removed; real golden-fixture tests land
in Task 5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Golden fixtures + comprehensive tests

The test matrix per the plan prompt, now that the function exists. Each test case captures a distinct behavior, either asserting exact-string match against a committed fixture (golden file) or asserting a structural property (determinism, empty-handling).

**Files:**
- Create: `$TE/.worktrees/xmeml-generator/server/services/__tests__/__fixtures__/xmeml/single-placement.xml`
- Create: `$TE/.worktrees/xmeml-generator/server/services/__tests__/__fixtures__/xmeml/two-non-overlapping.xml`
- Create: `$TE/.worktrees/xmeml-generator/server/services/__tests__/__fixtures__/xmeml/three-overlapping.xml`
- Create: `$TE/.worktrees/xmeml-generator/server/services/__tests__/__fixtures__/xmeml/missing-metadata.xml`
- Modify: `$TE/.worktrees/xmeml-generator/server/services/__tests__/xmeml-generator.test.js`

- [ ] **Step 1: Generate the fixtures from canonical inputs**

The practical pattern: write the test file with placeholder `toMatchFileSnapshot('__fixtures__/xmeml/...')` assertions, run `npx vitest run -u` (update snapshots), verify the generated XML by eye, then re-run to confirm the assertion passes.

Alternative (safer for a first-time test framework): generate the fixtures explicitly via a one-off node script, visually inspect, commit, then write tests that read-and-compare. This plan uses the explicit approach to keep the golden files in-tree as regular files rather than vitest-managed snapshot directories.

Create a one-off generator script (do NOT commit this — it's scaffolding):

```bash
mkdir -p server/services/__tests__/__fixtures__/xmeml
node -e '
import("./server/services/xmeml-generator.js").then(({ generateXmeml }) => {
  const fs = require("fs");

  // Case 1: single placement
  fs.writeFileSync(
    "server/services/__tests__/__fixtures__/xmeml/single-placement.xml",
    generateXmeml({
      sequenceName: "Variant C",
      placements: [
        { seq: 1, source: "envato", sourceItemId: "NX9WYGQ",
          filename: "001_envato_NX9WYGQ.mov",
          timelineStart: 25.4, timelineDuration: 4.0,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
    })
  );

  // Case 2: two non-overlapping on V1
  fs.writeFileSync(
    "server/services/__tests__/__fixtures__/xmeml/two-non-overlapping.xml",
    generateXmeml({
      sequenceName: "Variant A",
      placements: [
        { seq: 1, source: "pexels", sourceItemId: "123",
          filename: "001_pexels_123.mp4",
          timelineStart: 0, timelineDuration: 2,
          width: 1920, height: 1080, sourceFrameRate: 30 },
        { seq: 2, source: "pexels", sourceItemId: "456",
          filename: "002_pexels_456.mp4",
          timelineStart: 3, timelineDuration: 2,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
    })
  );

  // Case 3: three overlapping → V1/V2/V3
  fs.writeFileSync(
    "server/services/__tests__/__fixtures__/xmeml/three-overlapping.xml",
    generateXmeml({
      sequenceName: "Variant C",
      placements: [
        { seq: 1, source: "envato", sourceItemId: "A",
          filename: "001_envato_A.mov",
          timelineStart: 0, timelineDuration: 4,
          width: 1920, height: 1080, sourceFrameRate: 30 },
        { seq: 2, source: "envato", sourceItemId: "B",
          filename: "002_envato_B.mov",
          timelineStart: 1, timelineDuration: 4,
          width: 1920, height: 1080, sourceFrameRate: 30 },
        { seq: 3, source: "envato", sourceItemId: "C",
          filename: "003_envato_C.mov",
          timelineStart: 2, timelineDuration: 4,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
    })
  );

  // Case 4: missing metadata → defaults to 1920x1080/30fps
  fs.writeFileSync(
    "server/services/__tests__/__fixtures__/xmeml/missing-metadata.xml",
    generateXmeml({
      sequenceName: "Variant B",
      placements: [
        { seq: 1, source: "freepik", sourceItemId: "xyz",
          filename: "001_freepik_xyz.mp4",
          timelineStart: 0, timelineDuration: 3 },
          // width/height/sourceFrameRate omitted → should use defaults
      ],
    })
  );

  console.log("fixtures written");
});
'
```

Open each file in your editor and eyeball it:

- `single-placement.xml` — exactly matches the spec's example (sequence `<duration>882</duration>`, clipitem `<start>762</start><end>882</end>`, in=0 out=120).
- `two-non-overlapping.xml` — one `<track>`, two `<clipitem>` inside.
- `three-overlapping.xml` — three `<track>` elements, one clipitem each. The first track has seq=1 (start=0,end=120), second has seq=2 (start=30,end=150), third seq=3 (start=60,end=180).
- `missing-metadata.xml` — placement's `<width>1920</width><height>1080</height>` and source rate 30 even though not specified in input.

If any fixture looks wrong, the bug is in `generateXmeml` — fix the function, not the fixture.

- [ ] **Step 2: Replace the test file with the final comprehensive suite**

Rewrite `server/services/__tests__/xmeml-generator.test.js`. Keep the `escapeXml`, `sanitizeFilename`, `secondsToFrames`, `assignTracks` describe blocks from earlier tasks unchanged. Add:

```js
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { generateXmeml } from '../xmeml-generator.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FIXTURES = path.join(__dirname, '__fixtures__', 'xmeml')

function loadFixture(name) {
  return readFileSync(path.join(FIXTURES, name), 'utf-8')
}

describe('generateXmeml — golden fixtures', () => {
  it('Case 1: single placement, single track, matches fixture', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant C',
      placements: [
        { seq: 1, source: 'envato', sourceItemId: 'NX9WYGQ',
          filename: '001_envato_NX9WYGQ.mov',
          timelineStart: 25.4, timelineDuration: 4.0,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
    })
    expect(xml).toBe(loadFixture('single-placement.xml'))
  })

  it('Case 2: two non-overlapping placements, both on V1', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant A',
      placements: [
        { seq: 1, source: 'pexels', sourceItemId: '123',
          filename: '001_pexels_123.mp4',
          timelineStart: 0, timelineDuration: 2,
          width: 1920, height: 1080, sourceFrameRate: 30 },
        { seq: 2, source: 'pexels', sourceItemId: '456',
          filename: '002_pexels_456.mp4',
          timelineStart: 3, timelineDuration: 2,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
    })
    expect(xml).toBe(loadFixture('two-non-overlapping.xml'))
    // Structural assertion: exactly one <track> opening
    expect((xml.match(/<track>/g) || []).length).toBe(1)
  })

  it('Case 3: three overlapping placements → V1, V2, V3', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant C',
      placements: [
        { seq: 1, source: 'envato', sourceItemId: 'A',
          filename: '001_envato_A.mov',
          timelineStart: 0, timelineDuration: 4,
          width: 1920, height: 1080, sourceFrameRate: 30 },
        { seq: 2, source: 'envato', sourceItemId: 'B',
          filename: '002_envato_B.mov',
          timelineStart: 1, timelineDuration: 4,
          width: 1920, height: 1080, sourceFrameRate: 30 },
        { seq: 3, source: 'envato', sourceItemId: 'C',
          filename: '003_envato_C.mov',
          timelineStart: 2, timelineDuration: 4,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
    })
    expect(xml).toBe(loadFixture('three-overlapping.xml'))
    expect((xml.match(/<track>/g) || []).length).toBe(3)
  })

  it('Case 4: missing metadata falls back to sequence defaults', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant B',
      placements: [
        { seq: 1, source: 'freepik', sourceItemId: 'xyz',
          filename: '001_freepik_xyz.mp4',
          timelineStart: 0, timelineDuration: 3 },
      ],
    })
    expect(xml).toBe(loadFixture('missing-metadata.xml'))
    // Structural: emitted width/height are the sequence defaults
    expect(xml).toContain('<width>1920</width><height>1080</height>')
    expect(xml).toContain('<timebase>30</timebase>')
  })
})

describe('generateXmeml — sanitization + edge cases', () => {
  it('Case 5: filename with reserved chars is sanitized in <name> and <pathurl>', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant C',
      placements: [
        { seq: 1, source: 'envato', sourceItemId: 'X',
          filename: 'bad<name>:clip|001?.mov',  // all 5 reserved chars
          timelineStart: 0, timelineDuration: 1,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
    })
    // Reserved chars replaced with _; the raw input never appears.
    expect(xml).not.toContain('bad<name>')
    expect(xml).toContain('bad_name_')
    // <name> and <pathurl> both use the sanitized form
    expect(xml).toMatch(/<name>bad_name_[^<]*<\/name>/)
    expect(xml).toContain('file://./media/bad_name_')
  })

  it('Case 5b: XML reserved chars in sequenceName are escaped', () => {
    const xml = generateXmeml({
      sequenceName: 'Variant & Co <demo>',
      placements: [],
    })
    expect(xml).toContain('<name>Variant &amp; Co &lt;demo&gt;</name>')
    // Raw "Variant & Co <demo>" does NOT appear as-is
    expect(xml).not.toContain('<name>Variant & Co <demo></name>')
  })

  it('Case 6: empty placements array → valid empty <sequence>', () => {
    const xml = generateXmeml({
      sequenceName: 'Empty',
      placements: [],
    })
    // Must be valid xmeml (contains the wrapper)
    expect(xml).toMatch(/^<\?xml version="1\.0"/)
    expect(xml).toContain('<xmeml version="5">')
    expect(xml).toContain('<sequence ')
    expect(xml).toContain('<duration>0</duration>')
    // No <track> elements (zero placements → zero tracks)
    expect(xml).not.toContain('<track>')
    // Ends with the document close
    expect(xml.trim().endsWith('</xmeml>')).toBe(true)
  })

  it('Case 7: determinism — two calls with the same input produce identical output', () => {
    const input = {
      sequenceName: 'Variant C',
      placements: [
        { seq: 1, source: 'envato', sourceItemId: 'A',
          filename: '001_envato_A.mov',
          timelineStart: 0, timelineDuration: 4,
          width: 1920, height: 1080, sourceFrameRate: 30 },
        { seq: 2, source: 'envato', sourceItemId: 'B',
          filename: '002_envato_B.mov',
          timelineStart: 1, timelineDuration: 4,
          width: 1920, height: 1080, sourceFrameRate: 30 },
      ],
    }
    const a = generateXmeml(input)
    const b = generateXmeml(input)
    expect(a).toBe(b)
    // Also verify: byte-identical length as a pure sanity check
    expect(Buffer.byteLength(a)).toBe(Buffer.byteLength(b))
  })
})

describe('generateXmeml — input validation', () => {
  it('throws on non-string sequenceName', () => {
    expect(() => generateXmeml({ sequenceName: '', placements: [] })).toThrow()
    expect(() => generateXmeml({ sequenceName: null, placements: [] })).toThrow()
    expect(() => generateXmeml({ sequenceName: 123, placements: [] })).toThrow()
  })

  it('throws on non-array placements', () => {
    expect(() => generateXmeml({ sequenceName: 'x', placements: null })).toThrow()
    expect(() => generateXmeml({ sequenceName: 'x', placements: 'abc' })).toThrow()
  })

  it('throws on invalid frameRate', () => {
    expect(() => generateXmeml({ sequenceName: 'x', placements: [], frameRate: 0 })).toThrow()
    expect(() => generateXmeml({ sequenceName: 'x', placements: [], frameRate: -30 })).toThrow()
  })

  it('throws on placement missing filename', () => {
    expect(() => generateXmeml({
      sequenceName: 'x',
      placements: [{ seq: 1, timelineStart: 0, timelineDuration: 1 }],
    })).toThrow(/filename/)
  })
})
```

- [ ] **Step 3: Run the full suite**

```bash
npm test 2>&1 | tail -15
```

Expected: all tests pass (19 from earlier tasks + 4 golden + 3 sanitization + 1 empty + 1 determinism + 4 validation = 32 total, or close to it). All 4 fixtures load.

If a golden test fails with a diff, the generator output has drifted from the committed fixture. Diff the actual output against the fixture; fix whichever is wrong (usually the generator, since fixtures are committed deliberately).

- [ ] **Step 4: Commit fixtures + tests together**

```bash
git add server/services/__tests__/__fixtures__/xmeml/ server/services/__tests__/xmeml-generator.test.js
git status --short
# Expected: 4 fixture .xml files + the test file, all staged.
git commit -m "$(cat <<'EOF'
test(xml): golden fixtures + comprehensive generateXmeml suite

Four committed .xml fixtures under __tests__/__fixtures__/xmeml/
capture the four structural shapes the spec calls out:
- single placement / single track
- two non-overlapping → stacked on V1
- three overlapping → stacked on V1/V2/V3
- missing per-placement metadata → sequence defaults

Plus sanitization (reserved chars in filenames + XML-reserved chars
in sequenceName) and edge cases (empty array, determinism) and input
validation.

Regenerate fixtures by running the one-off node script in task 4
and re-committing; the test suite catches drift as an equality
failure with a pointed XML diff.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Service-layer `getExportResult()` helper

The endpoint needs the post-run per-item resolved filenames (from `exports.result_json`, populated by Phase 1's `recordExportEvent({event: 'export_completed', meta})`). Add a small service helper rather than inlining SQL in the route.

**Files:**
- Modify: `$TE/.worktrees/xmeml-generator/server/services/exports.js`

- [ ] **Step 1: Add `getExportResult` to the exports service**

Use Edit to insert immediately after the existing `getExport` function. Anchor on the closing `}` of `getExport` followed by a blank line.

`old_string` (last lines of `getExport`):
```
  if (userId && row.user_id !== userId) return null
  return row
}
```

`new_string`:
```
  if (userId && row.user_id !== userId) return null
  return row
}

// Read the post-run per-item result payload. Populated by
// recordExportEvent when an `export_completed` event arrives with
// `meta` containing the per-item resolved filenames + placement data.
// Returns null if the export doesn't exist, doesn't belong to
// `userId`, or hasn't completed yet.
//
// Shape of returned object (when non-null):
//   {
//     export_id, status, folder_path,
//     variants: [{
//       label, sequenceName,
//       placements: [{ seq, source, sourceItemId, filename,
//         timelineStart, timelineDuration,
//         width?, height?, sourceFrameRate? }, ...]
//     }, ...]
//   }
//
// The placements array is exactly the input shape generateXmeml()
// expects. Upstream Phase 1 is responsible for writing this shape
// into exports.result_json; see docs/specs/2026-04-23-envato-export-design.md
// § "Partial-run XML".
export async function getExportResult(id, { userId } = {}) {
  const row = await db.prepare(
    'SELECT id, user_id, status, folder_path, result_json FROM exports WHERE id = ?'
  ).get(id)
  if (!row) return null
  if (userId && row.user_id && row.user_id !== userId) return null
  if (!row.result_json) return null
  let parsed
  try { parsed = JSON.parse(row.result_json) } catch { return null }
  if (!parsed || !Array.isArray(parsed.variants)) return null
  return {
    export_id: row.id,
    status: row.status,
    folder_path: row.folder_path || null,
    variants: parsed.variants,
  }
}
```

- [ ] **Step 2: Spot-check the function exists and imports correctly**

```bash
node --check server/services/exports.js
# Expected: exit 0
```

- [ ] **Step 3: Commit**

```bash
git add server/services/exports.js
git commit -m "$(cat <<'EOF'
feat(exports): add getExportResult for per-variant XML generation

Reads exports.result_json — populated by Phase 1's export_completed
telemetry handler with the resolved on-disk filenames after
chrome.downloads.uniquify has settled — and returns the shape the
XMEML generator consumes: per-variant list of placements.

Owner-checked against userId; collapses missing-vs-not-owned to
null to avoid a known-export-id enumeration oracle.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Note: if Phase 1's `recordExportEvent` doesn't yet write the `variants: [...]` structure to `result_json` (current Phase 1 writes the raw `meta` object directly), that's a Phase 1 amendment this plan does not ship. Option A is to document the contract here and let WebApp.1's `handle 'complete' postMessage` write the variants shape before calling this endpoint. Option B is to amend Phase 1. This plan picks A: the endpoint's contract is "given an export with a properly-shaped result_json, generate XML"; upstream is responsible for writing the shape. Surface this explicitly in the endpoint's error messages (Task 6).

---

## Task 6: Endpoint — `POST /api/exports/:id/generate-xml`

The small HTTP adapter around the generator. ~80 LOC total including error paths.

**Files:**
- Create: `$TE/.worktrees/xmeml-generator/server/routes/export-xml.js`
- Modify: `$TE/.worktrees/xmeml-generator/server/index.js`

- [ ] **Step 1: Write the route handler**

```js
// POST /api/exports/:id/generate-xml
//
// Called by the transcript-eval web app AFTER the Chrome extension
// signals export completion (i.e. after Phase 1's `export_completed`
// telemetry event has landed and updated exports.result_json).
//
// Auth: Bearer JWT via requireAuth (reuses Supabase JWT). The export
// must belong to req.auth.userId, else 404 (missing-vs-not-owned
// collapsed to prevent enumeration).
//
// Request body: { variants: ["A", "C", ...] }  — subset of labels the
// user opted into. Each must match a label in the export's result_json.
//
// Response: { xml_by_variant: { "A": "<?xml ...?>...", "C": "..." } }
//
// Error shape: { error: <string>, detail?: <string> } with HTTP codes:
//   400 — bad input (variants missing/non-array, unknown labels)
//   401 — missing/invalid JWT (from requireAuth)
//   404 — export not found, not owned, or result_json not populated
//   500 — generator threw (unexpected; surfaces as JSON)

import { Router } from 'express'
import { requireAuth } from '../auth.js'
import { getExportResult } from '../services/exports.js'
import { generateXmeml } from '../services/xmeml-generator.js'

const router = Router()

router.post('/:id/generate-xml', requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth?.userId
    if (!userId) {
      // requireAuth should have already 401'd, but defense in depth.
      return res.status(401).json({ error: 'Authentication required' })
    }

    const { id } = req.params
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'export id required' })
    }

    const { variants } = req.body || {}
    if (!Array.isArray(variants) || variants.length === 0) {
      return res.status(400).json({ error: 'variants must be a non-empty array of labels' })
    }
    if (!variants.every((v) => typeof v === 'string' && v)) {
      return res.status(400).json({ error: 'each variant must be a non-empty string' })
    }

    // Fetch + owner-check. getExportResult collapses missing/not-owned to
    // null, so from here on we can 404 uniformly.
    const result = await getExportResult(id, { userId })
    if (!result) {
      return res.status(404).json({ error: 'export not found or not ready' })
    }

    // Index variants by label for O(1) lookup; reject any requested
    // variant the export doesn't carry.
    const byLabel = new Map(result.variants.map((v) => [v.label, v]))
    const unknown = variants.filter((v) => !byLabel.has(v))
    if (unknown.length > 0) {
      return res.status(400).json({
        error: 'unknown variant label(s)',
        detail: unknown.join(','),
      })
    }

    // Generate per variant. Loop is sequential since each call is
    // CPU-bound microseconds of string concat — no benefit to Promise.all.
    const xml_by_variant = {}
    for (const label of variants) {
      const v = byLabel.get(label)
      xml_by_variant[label] = generateXmeml({
        sequenceName: v.sequenceName || `Variant ${label}`,
        placements: v.placements || [],
        // frameRate + sequenceSize fall through to generator defaults;
        // future manifest fields could override here.
      })
    }

    res.json({ xml_by_variant })
  } catch (err) {
    // Unexpected (e.g. generator assertion fires on malformed
    // per-placement data). Log and surface a generic 500 — the
    // generator's own error messages already name the offending field.
    next(err)
  }
})

export default router
```

- [ ] **Step 2: Wire the router in `server/index.js`**

Use Edit. Anchor on the Phase 1 exports imports.

`old_string`:
```
import exportsRouter, { sessionTokenRouter, exportEventsRouter, pexelsUrlRouter, freepikUrlRouter } from './routes/exports.js'
```

`new_string`:
```
import exportsRouter, { sessionTokenRouter, exportEventsRouter, pexelsUrlRouter, freepikUrlRouter } from './routes/exports.js'
import exportXmlRouter from './routes/export-xml.js'
```

Then mount — anchor on the existing `/api/exports` mount:

`old_string`:
```
app.use('/api/exports', exportsRouter)
app.use('/api/session-token', sessionTokenRouter)
```

`new_string`:
```
app.use('/api/exports', exportsRouter)
app.use('/api/exports', exportXmlRouter)
app.use('/api/session-token', sessionTokenRouter)
```

Note: both routers mount at `/api/exports`. Express evaluates them in registration order; `exportsRouter` handles `POST /` and `GET /:id`, while `exportXmlRouter` handles `POST /:id/generate-xml`. There's no collision because the routes have distinct paths.

- [ ] **Step 3: Syntax check**

```bash
node --check server/routes/export-xml.js
node --check server/index.js
# Expected: exit 0 for both
```

- [ ] **Step 4: Commit**

```bash
git add server/routes/export-xml.js server/index.js
git commit -m "$(cat <<'EOF'
feat(api): POST /api/exports/:id/generate-xml — per-variant xmeml

Wraps generateXmeml() in a thin Express adapter:
- requireAuth (Supabase JWT); rejects 401 if missing
- owner-checks the export via getExportResult; collapses
  missing/not-owned to 404 to avoid enumeration
- validates body.variants is a non-empty string[] of known labels
- loops variants, returns { xml_by_variant: { label: xml, ... } }

Mounted at /api/exports so URLs stay consistent with POST /api/exports
and GET /api/exports/:id. Registered after the Phase 1 router; no
path collisions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Curl smoke test + manual Premiere-import spot-check

The unit tests in Task 4 prove the generator is structurally correct and deterministic. This task verifies (a) the endpoint reaches it correctly and (b) the output Premiere actually opens.

Two substeps. The curl smoke is automated; the Premiere spot-check is manual and may be deferred to acceptance review if Premiere isn't handy.

**Files:** no code changes (verification only).

- [ ] **Step 1: Seed a test export row (manual; dev DB)**

Run the dev server in one terminal:

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/xmeml-generator"
cd "$TE"
node --env-file=.env server/index.js
```

In another terminal, seed a minimal export row with a populated `result_json`:

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/xmeml-generator"
cd "$TE"
set -a && source .env && set +a
node -e '
import("pg").then(async ({default: pg}) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false}, max: 1 });
  const id = "exp_TESTXMEML0000000000000000";  // non-ULID test ID, OK because we allow any TEXT
  const resultJson = JSON.stringify({
    variants: [{
      label: "C",
      sequenceName: "Variant C",
      placements: [
        { seq: 1, source: "envato", sourceItemId: "NX9WYGQ",
          filename: "001_envato_NX9WYGQ.mov",
          timelineStart: 25.4, timelineDuration: 4.0,
          width: 1920, height: 1080, sourceFrameRate: 30 },
        { seq: 2, source: "pexels", sourceItemId: "456",
          filename: "002_pexels_456.mp4",
          timelineStart: 30.0, timelineDuration: 5.0 },
      ],
    }],
  });
  await pool.query(`
    INSERT INTO exports (id, user_id, plan_pipeline_id, variant_labels, status, manifest_json, result_json, folder_path, created_at, completed_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET result_json = EXCLUDED.result_json, status = EXCLUDED.status
  `, [id, "dev", "test-pipeline-1", JSON.stringify(["C"]), "complete", "{}", resultJson, "~/Downloads/te/export-test-c"]);
  console.log("seeded:", id);
  await pool.end();
});
'
```

Expected output: `seeded: exp_TESTXMEML0000000000000000`.

- [ ] **Step 2: Curl the endpoint with the dev-bypass header**

```bash
curl -sS -X POST http://localhost:3001/api/exports/exp_TESTXMEML0000000000000000/generate-xml \
  -H "Content-Type: application/json" \
  -H "X-Dev-Bypass: true" \
  -d '{"variants":["C"]}' | tee /tmp/xmeml-resp.json | head -c 300
echo
```

Expected: JSON response with `xml_by_variant.C` containing a string starting with `<?xml version="1.0"`. No `error` field.

Extract and save the XML:

```bash
node -e 'const j = require("/tmp/xmeml-resp.json"); require("fs").writeFileSync("/tmp/test-variant-c.xml", j.xml_by_variant.C); console.log("wrote /tmp/test-variant-c.xml,", j.xml_by_variant.C.length, "bytes")'
```

Expected: non-zero byte count, file on disk.

- [ ] **Step 3: Validate error paths**

```bash
# 404 on unknown id
curl -sS -X POST http://localhost:3001/api/exports/nonexistent/generate-xml \
  -H "Content-Type: application/json" -H "X-Dev-Bypass: true" \
  -d '{"variants":["C"]}'
echo
# Expected: {"error":"export not found or not ready"}

# 400 on missing variants
curl -sS -X POST http://localhost:3001/api/exports/exp_TESTXMEML0000000000000000/generate-xml \
  -H "Content-Type: application/json" -H "X-Dev-Bypass: true" \
  -d '{}'
echo
# Expected: {"error":"variants must be a non-empty array of labels"}

# 400 on unknown variant label
curl -sS -X POST http://localhost:3001/api/exports/exp_TESTXMEML0000000000000000/generate-xml \
  -H "Content-Type: application/json" -H "X-Dev-Bypass: true" \
  -d '{"variants":["Z"]}'
echo
# Expected: {"error":"unknown variant label(s)","detail":"Z"}

# 401 without auth header (no dev bypass)
curl -sS -X POST http://localhost:3001/api/exports/exp_TESTXMEML0000000000000000/generate-xml \
  -H "Content-Type: application/json" \
  -d '{"variants":["C"]}'
echo
# Expected: {"error":"Authentication required"} (or similar — 401 from requireAuth)
```

- [ ] **Step 4: (OPTIONAL — manual, may defer) Premiere-import spot-check**

Only if Adobe Premiere is installed on the dev machine:

1. Create a test folder `~/Downloads/te-xmeml-test/`.
2. Inside, create a `media/` subfolder.
3. Copy any two short `.mov` / `.mp4` files into `media/`, renaming to `001_envato_NX9WYGQ.mov` and `002_pexels_456.mp4` to match the seeded fixture.
4. Copy `/tmp/test-variant-c.xml` into `~/Downloads/te-xmeml-test/variant-c.xml`.
5. In Premiere: File → Import → select `variant-c.xml` → Import.
6. Premiere should create a sequence named "Variant C" with two clips placed at the timeline positions described in the input (seq 1 at 00:00:25:12, seq 2 at 00:00:30:00).

If Premiere imports cleanly, the end-to-end path works. If it doesn't, capture the Premiere error + the exact XML that failed, and open a follow-up ticket — don't "fix" the generator speculatively.

Defer this step to acceptance review if Premiere isn't immediately available. The unit tests + curl smoke are sufficient signal for a local merge-ready state; Premiere compatibility is a quarterly-regression-style check, not a per-commit one.

- [ ] **Step 5: Clean up the seeded row**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/xmeml-generator"
cd "$TE"
set -a && source .env && set +a
node -e '
import("pg").then(async ({default: pg}) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false}, max: 1 });
  await pool.query(`DELETE FROM exports WHERE id = $1`, ["exp_TESTXMEML0000000000000000"]);
  console.log("deleted");
  await pool.end();
});
'
```

- [ ] **Step 6: Do NOT commit anything from this task**

There are no code changes. If you edited code to debug, re-land as a proper fix in a new commit with a pointed message.

```bash
git status
# Expected: "nothing to commit, working tree clean"
```

---

## Task 8: Final branch review + push gate

**Files:** no code changes — this is a pre-merge sanity check.

- [ ] **Step 1: Run the full test suite a final time**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/xmeml-generator"
cd "$TE"
npm test 2>&1 | tail -10
# Expected: all tests pass.
```

- [ ] **Step 2: Review the full diff**

```bash
git log --oneline main..HEAD
# Expected: roughly 8 commits:
#   chore(test): introduce vitest as the project test framework
#   feat(xml): escapeXml helper + stub module for XMEML generator
#   feat(xml): filename sanitizer, seconds→frames, track assignment
#   feat(xml): generateXmeml — pure FCP7 xmeml emitter
#   test(xml): golden fixtures + comprehensive generateXmeml suite
#   feat(exports): add getExportResult for per-variant XML generation
#   feat(api): POST /api/exports/:id/generate-xml — per-variant xmeml
#   (plus docs commit if this plan file was committed during planning)
```

```bash
git diff main --stat
# Expected additions (approximate):
#   docs/superpowers/plans/2026-04-24-webapp-xmeml-generator.md       (this plan)
#   package.json                                                      (+3 lines)
#   package-lock.json                                                 (lots; vitest tree)
#   server/index.js                                                   (+2 lines)
#   server/routes/export-xml.js                                       (~80 lines)
#   server/services/exports.js                                        (~40 lines)
#   server/services/xmeml-generator.js                                (~250 lines)
#   server/services/__tests__/xmeml-generator.test.js                 (~250 lines)
#   server/services/__tests__/__fixtures__/xmeml/*.xml                (4 fixtures)
#   vitest.config.js                                                  (~20 lines)
```

If the diff surfaces changes OUTSIDE those files — investigate. You may have accidentally modified unrelated files.

- [ ] **Step 3: Verify the endpoint registers without booting**

```bash
node --check server/index.js
node --check server/routes/export-xml.js
node --check server/services/xmeml-generator.js
node --check server/services/exports.js
# All four exit 0.
```

- [ ] **Step 4: DO NOT push**

Per user convention: `git push` requires explicit consent. This task's acceptance is "all commits on the local branch, test suite green, curl smoke green, branch ready for review." Surface the branch name + last commit sha to the user; ask before pushing.

```bash
git branch --show-current
git log --oneline -1
```

---

## Self-review against the spec

After completing Tasks 0–8, re-read the main spec's "XMEML generation" section and the roadmap's "WebApp.2 — XMEML generator" slice.

### Main spec coverage (`docs/specs/2026-04-23-envato-export-design.md`)

**§ "XMEML generation"** — the target XML template.
- `<?xml version="1.0" encoding="UTF-8"?>` + `<!DOCTYPE xmeml>` + `<xmeml version="5">` wrapper — Task 3, verified in fixtures ✓
- `<sequence id="seq-c"><name>Variant C</name><duration>N</duration>` — Task 3 ✓
- `<rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>` at sequence level — Task 3 ✓
- `<samplecharacteristics>` with width/height + rate — Task 3 ✓
- `<track>` with `<clipitem>` per placement; id, name, start/end/in/out, `<file>` with `<pathurl>file://./media/...`, duration, rate, inner `<samplecharacteristics>` — Task 3 ✓

**§ "Filename sanitization"** — spec's four rules.
- ASCII-only — Task 2 (NON_PRINTABLE_ASCII regex drops bytes outside 0x20-0x7E) ✓
- Replace `<>:"|?*` with `_` — Task 2 (RESERVED_CHARS regex) ✓
- Path length cap 240 — Task 2 (MAX_PATH_LEN = 240) ✓
- Scheme `<NNN>_<source>_<source_item_id>.<ext>` — produced upstream by the extension; generator's job is to PRESERVE a valid scheme, not enforce it. Documented in Task 2 module-header comment ✓

**§ "Overlapping timeline placements"** — the greedy algorithm.
- Sort by start → greedy lowest-index track — Task 2 `assignTracks` ✓
- Half-open intervals (butt-splices share a track) — Task 2 test case ✓
- Deterministic seq tiebreak on identical starts — Task 2 test case ✓
- Emits multiple `<track>` elements in V1, V2, ... order — Task 3 test case 3 ✓

**§ "Missing metadata fallback"**.
- 1920×1080 / 30fps when metadata absent — Task 3 + fixture `missing-metadata.xml` ✓

**§ "Generator: server/services/xmeml-generator.js (~300 LOC)"**.
- Pure function signature `generateXmeml({sequenceName, placements, frameRate, sequenceSize})` — Task 3 ✓
- Returns XML string (not a writer) — Task 3 ✓
- "Unit-tested. Inputs sanitized, XML escaped." — Task 4 (golden + sanitization tests) ✓

### Roadmap coverage (`docs/specs/2026-04-24-export-remaining-roadmap.md § WebApp.2`)

**Files specified:**
- `server/services/xmeml-generator.js` — single ~300-LOC pure function ✓ (~250 LOC final)
- `server/services/__tests__/xmeml-generator.test.js` — vitest unit tests ✓
- `server/routes/export-xml.js` — POST endpoint ✓

**Key decisions:**
- Greedy interval scheduling — ✓ Task 2
- Default 1920×1080 / 30fps — ✓ Task 3
- ASCII-only, 240-char cap — ✓ Task 2
- Deterministic — ✓ Task 4 case 7

**Verification:**
- Unit tests multi-variant / overlapping / missing metadata — ✓ Task 4 cases 1-4
- Manual Premiere import of generated XML — Task 7 step 4 (optional / deferred to acceptance review)

### Open questions resolved by this plan

- **OQ7 (XMEML test strategy)** → `vitest` + golden fixtures, established as the project-wide pattern for future pure-function slices. Task 0. ✓

### Open questions NOT resolved (expected — not in scope)

- OQ1 (Beta Envato subscription) → Ext.2.
- OQ3 (Target folder picker) → WebApp.1 State C.
- OQ4 (Admin UI auth) → WebApp.3.
- OQ5 (Multi-user org) → post-GA.
- OQ6 (Canary channel) → Ext.11.

### Contract boundary with other phases

| Phase | We consume | We produce |
|---|---|---|
| Phase 1 (backend) | `requireAuth`, `exports` table, `getExport`, `recordExportEvent` write shape | — |
| Ext.5+ (extension queue) | final on-disk filenames via `export_completed` event `meta` | — |
| WebApp.1 (export page) | — | `POST /api/exports/:id/generate-xml` response `{xml_by_variant}` |
| WebApp.3 (admin UI) | — | (none — admin reads exports/events directly, not XML) |

The one hard upstream contract: **Phase 1's `recordExportEvent` must write `result_json` in the shape `getExportResult()` reads**. Today, Phase 1 writes the raw `meta` object directly. If `meta` doesn't contain `{variants: [{label, sequenceName, placements: [...]}, ...]}`, the endpoint returns 404 with `"export not found or not ready"`. This is consistent with the spec's "Partial-run XML" behavior but it's a coordination point — when WebApp.1 wires the extension's `complete` message into `POST /api/export-events`, the `meta` it forwards MUST include the variants shape. Add a test-time assertion there when WebApp.1 lands; do NOT amend Phase 1 blind.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-24-webapp-xmeml-generator.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration with two-stage (spec + code) review on each task.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
