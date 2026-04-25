# Ext.10 — Cross-browser + CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

Ext.10 ships the **build + CI packaging pipeline** for the transcript-eval extension. After this phase, a developer can produce a reproducible, Web-Store-ready `.zip` locally with `npm run ext:package`, and a GitHub Actions workflow produces the same artifact on every `main` push that touches `extension/**`. On a tagged release (`ext-v0.9.0` and friends) the workflow uploads the `.zip` to a GitHub Release so downstream phases (Ext.11 Web Store submission; self-hosted fallback) can consume it. No runtime behavior change — the extension stays at **v0.9.0**. The scope is strictly: a Node packaging script, a GitHub Actions workflow, a handful of unit tests around the packager, `.gitignore` updates, and README docs for the cross-browser compatibility matrix. No Puppeteer/headless-browser CI smoke (deferred — see Open Question 2). No `.crx` signing (deferred — see Open Question 1). No Chrome Web Store auto-submission (that's Ext.11).

## Architecture

Ext.10 is a **pure infrastructure phase** — zero changes to extension runtime code. One new Node script (`extension/scripts/package.mjs`) reads `extension/manifest.json` for the version, stages an explicit **include-list** of runtime files into a fresh `extension/dist/` directory, and zips the result to `extension/dist/extension-${version}.zip` using `fflate` (already a runtime dep from Ext.8's diagnostic bundle). One new GitHub Actions workflow (`.github/workflows/extension-build.yml`) runs on push-to-`main` with a `paths:` filter for `extension/**`, on tag push matching `ext-v*`, and on manual `workflow_dispatch`. The push-to-main and dispatch paths upload a workflow-run artifact (ephemeral, 90-day retention); the tag path publishes the same `.zip` as a GitHub Release asset via `softprops/action-gh-release@v2`.

The packaging script is deliberately an **include-list, not an exclude-list**: a future developer adding debug files (`.tmp`, `scratch.js`, `local-creds.json`, `.private-key.pem`) to `extension/` must NOT accidentally ship them. The include list names each runtime file and each runtime directory explicitly. Tests live at `extension/scripts/__tests__/package.test.js` and shell out to the script with `--no-zip --out <tmpdir>` to assert the staged file tree matches the expected include set (and that excluded files — `.extension-id`, `__tests__/`, `scripts/`, `README.md` — are absent). Total new code footprint: ~200 lines of script + ~100 lines of tests + ~60 lines of YAML + ~30 lines of README.

## Tech Stack

- **Node 20** (CI matrix uses Ubuntu latest + `actions/setup-node@v4` with `node-version: '20'`).
- **`fflate`** for zip creation — already a runtime dep (see `package.json` dependencies list, added in Ext.8 for diagnostic bundles). Deterministic by default when no timestamp fields are populated; we rely on that.
- **Node stdlib only** beyond `fflate`: `node:fs/promises`, `node:path`, `node:url`, `node:process`, `node:crypto` (sha256 of the resulting `.zip` for a log line, not for signing).
- **GitHub Actions:** `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`, `softprops/action-gh-release@v2`. No other actions.
- **Vitest** (existing test runner) for the packager tests. No new dev dep.

## Open questions for the user

1. **`.crx` generation in scope or deferred?** **Recommend deferred** to a mini-PR (call it Ext.10.5). The Chrome Web Store accepts `.zip` uploads directly — `.crx` is only needed for self-hosted distribution (downloading and side-loading a signed package). Self-hosted distribution additionally needs the Ext.1 private key in CI secrets + a CRX3 signing implementation (non-trivial — the `crx` npm package is unmaintained; CRX3 is a bespoke binary format). Ext.10 produces the `.zip` only; Ext.11 uploads that `.zip` to the Web Store. If user wants `.crx` in this phase, add a Task 6.5 that reads `EXTENSION_PRIVATE_KEY` env var (base64-encoded PEM) OR `extension/.private-key.pem` file, signs a CRX3 payload, and emits `dist/extension-${version}.crx` alongside the `.zip`. **Default: defer.**

2. **Headless-browser CI smoke in scope?** **Recommend a minimal "manifest parses + include-list complete" smoke, NOT a Puppeteer end-to-end.** A headless Chrome harness via Puppeteer (~50 lines of smoke + `puppeteer` devDep + Xvfb setup + SW-boot wait) is real work and adds a flaky CI step for essentially zero additional confidence beyond "the zip is valid". Instead, add a small "validate-dist" step in the workflow that: (a) unzips the built archive into a temp dir, (b) `node -e 'JSON.parse(...)` parses `manifest.json`, (c) asserts the critical keys (`version`, `manifest_version: 3`, `background.service_worker`, `key`, expected `permissions` array length), (d) asserts `service_worker.js` + `popup.html` + `modules/auth.js` + `modules/config-fetch.js` exist. This is ~20 lines of inline workflow Bash + node. **Alternative:** skip CI validation entirely and rely on the manual smoke in Task 10. **Default: minimal validate-dist step in the workflow.**

3. **Chrome Web Store auto-submission on tag?** **Recommend DEFER to Ext.11.** The Chrome Web Store API supports programmatic uploads (`chromewebstore-upload-cli`), but it requires OAuth refresh tokens stored in CI secrets + manual reviewer approval still gates the actual release. Ext.11 owns the Web Store console work (listing text, screenshots, privacy policy review); slotting the upload step there matches the narrative boundary. **Default: defer.**

4. **Artifact retention policy.** GitHub Actions defaults to 90 days for workflow-run artifacts. That's plenty for "did the last main-push build pass?" confidence checks; GitHub Releases assets (from tag pushes) are permanent by design. **Recommend: accept the default 90-day retention for workflow artifacts; do NOT override.** Confirm.

5. **Which branch protection / required check?** Ext.10 does NOT add the workflow to any required-status-check rule. That's a repo admin task the user can flip later in GitHub UI once the workflow has been green for a week. **Flag only; no code change.**

## Why read this before touching code

1. **`extension/dist/` is throw-away output, NEVER committed.** `.gitignore` already excludes `extension/dist/` (confirmed at root `.gitignore` — the line was added defensively in an earlier phase). Verify that entry still exists at Task 0 and, if missing, restore it BEFORE any developer runs `npm run ext:package` locally. A committed `dist/` bloats the repo with per-version zip blobs and leaks `.extension-id` history if the gitignore ever drifts.

2. **The zip is an include-list, not an exclude-list.** The runtime set is: `manifest.json`, `service_worker.js`, `config.js`, `popup.html`, `popup.css`, `popup.js`, `modules/*.js` (non-test), `icons/*`, `fixtures/**`. EVERYTHING ELSE MUST NOT SHIP. In particular: `.extension-id`, `scripts/`, `README.md`, `modules/__tests__/`, `scripts/__tests__/`, any `.private-key.pem` someone might drop in, any `.log`, any `.DS_Store`. A future developer who adds `debug.html` to `extension/` must explicitly add it to the include list OR it stays out of the zip. Fail-closed, not fail-open.

3. **`.extension-id` is DEVELOPER-only — it's the output of Ext.1's key generation and MUST NOT ship.** The Web Store generates the installed extension's ID server-side from the `"key"` field in `manifest.json` (already present); `.extension-id` exists purely so developers can cross-check that the locally-built unpacked extension matches the Web Store ID during QA. Shipping `.extension-id` leaks no secret (the public key is already in `manifest.json`), but it's pointless junk in the distributed package.

4. **GitHub Actions runner has NO `node_modules` — CI runs `npm ci` first.** `package.mjs` must import ONLY Node stdlib + `fflate` (a runtime dep, so `npm ci` installs it). Any accidental `import` of a devDep (e.g., `vitest`, `happy-dom`) in the packaging script will fail in CI with a cryptic module-not-found. Validate the import list at Task 2 with a `node --input-type=module` one-liner.

5. **Tag format is `ext-v<semver>`, not `v<semver>`.** Prefixing with `ext-` keeps extension releases orthogonal to any future app-wide tags (`v1.2.0` for the web app, `ext-v1.2.0` for the extension). The workflow's trigger `tags: ['ext-v*']` matches only these; a stray `v0.9.0` tag pushed for the web app will NOT trigger the extension release.

6. **Artifact upload ≠ release.** Push-to-main + `workflow_dispatch` produce an `actions/upload-artifact` asset (ephemeral, bound to the workflow run, 90-day retention). Tag push ALSO uploads that artifact AND creates a GitHub Release with the `.zip` attached as a release asset (permanent, browsable at `github.com/<org>/<repo>/releases`). Never cross-wire them — a push-to-main that creates a Release would spam the Releases page; a tag push that skips the Release makes the tag unfindable. The two code paths are distinct jobs or distinct steps in the same job, guarded by `if: startsWith(github.ref, 'refs/tags/ext-v')`.

7. **`package.mjs` must be deterministic.** `fflate`'s `zipSync` with default options writes no timestamp fields (or uses fixed epoch `0` when the `mtime` field is unset) — verify this before trusting it. Running `package.mjs` twice in a row on the same inputs must produce byte-identical `.zip` outputs. A sha256 log line at the end of the script proves this at a glance. Determinism matters because the Web Store fingerprints uploads; a timestamp-poisoned zip produces a different sha256 every second and defeats reproducible-build debugging.

8. **No version bump this phase.** Ext.10 is CI infra; it does not alter extension runtime behavior. `extension/manifest.json` stays at `"version": "0.9.0"`; `extension/config.js` EXT_VERSION stays at `'0.9.0'`. Do NOT touch either file. The first version bump after Ext.10 lands will come from Ext.11 or a bugfix that actually changes runtime behavior.

9. **CI runs only on `extension/**` changes for push-to-main.** The workflow has `paths: ['extension/**', '.github/workflows/extension-build.yml', 'package.json', 'package-lock.json']` so unrelated web-app PRs don't burn CI minutes rebuilding the extension. Tag pushes bypass the path filter (tags fire regardless). Manual `workflow_dispatch` bypasses the path filter too.

10. **Matrix is single-OS (Ubuntu latest).** The extension is pure JavaScript — there's no native-compilation reason to build on Windows/macOS. Edge smoke on Windows was considered (see Open Question 2) and deferred. Keeping the matrix single-OS makes CI runs fast (~30s) and cheap.

## Scope (Ext.10 only — hold the line)

### In scope

1. **`extension/scripts/package.mjs` [NEW].** Deterministic Node packaging script. Reads manifest version, stages runtime files into `extension/dist/`, emits `extension/dist/extension-${version}.zip`. CLI flags: `--out <dir>`, `--no-zip`, `--verbose`. Logs final sha256 + byte size.
2. **`.github/workflows/extension-build.yml` [NEW].** GitHub Actions workflow. Triggers: push-to-`main` with `paths` filter; `workflow_dispatch`; tag `ext-v*`. Jobs: `build` (all triggers) → runs `npm ci && npm run ext:package`, uploads artifact; `release` (tag trigger only) → downloads artifact, creates GitHub Release, attaches `.zip`. Inline `validate-dist` step parses manifest + checks critical runtime files exist.
3. **`extension/scripts/__tests__/package.test.js` [NEW].** ~5 tests. Invokes `package.mjs` via `child_process.spawnSync` with `--no-zip --out <tmpdir>`; asserts the staged tree matches the expected include list; asserts exclusion list (`.extension-id`, tests, README, scripts/) is absent.
4. **`package.json` [MOD].** Add one script entry: `"ext:package": "node extension/scripts/package.mjs"`. No new dev deps, no new runtime deps.
5. **`.gitignore` [MOD — verify + document].** Confirm `extension/dist/` entry exists (it does, per file read at investigation). Add `extension/scripts/*.log` for the packager's verbose log output.
6. **`extension/README.md` [MOD].** Append "Ext.10 — Build + CI" section: how to run packager locally, what the workflow does, how to cut a tagged release, cross-browser compatibility table.
7. **Cross-browser compatibility table in README** (Chrome 120+, Edge — primary; Arc, Brave, Vivaldi, Opera — best-effort; Safari, Firefox — out of scope; Chromebook — untested).

### Deferred (explicitly NOT in scope)

- **`.crx` signing + self-hosted distribution** → Ext.10.5 or future phase.
- **Chrome Web Store auto-submission** → Ext.11 (submission phase).
- **Canary channel / second Web Store listing** → Ext.12.
- **Puppeteer-based headless browser smoke** → future phase if Ext.11 beta surfaces undetected bugs.
- **Windows runner + Edge matrix leg** → out of scope; Chromium engines share a runtime, a Chrome-loaded smoke is sufficient signal.
- **Changes to extension runtime code (`modules/`, `service_worker.js`, `popup.*`)** → Ext.10 is build + CI only. No runtime code edits.
- **Manifest `version` bump** → stays at `"0.9.0"`. No runtime behavior change.
- **Adding `extension-build.yml` to required status checks** → repo admin task, user flips post-merge.

## Prerequisites

- Weeks 1-4 merged to local `main`; Wave 1 (Ext.7 + WebApp.3 + State F) merged; Wave 2 (Ext.8) merged; Wave 3 (Ext.9 + WebApp.4) merged at `8f18f78`; Ext.9 extension at v0.9.0.
- Vitest 125/125 green on `main` baseline.
- Node 20+ installed locally.
- `fflate` already a runtime dep (confirmed at `package.json` dependencies, version `^0.8.2`).
- No existing `.github/workflows/` directory in this repo (confirmed — Ext.10 is the first CI). The executor creates `.github/` + `.github/workflows/` from scratch.
- User approval on **Open Question 1** (defer `.crx`) BEFORE Task 1. If the user wants `.crx` in scope, add Task 6.5.
- User approval on **Open Question 2** (minimal validate-dist smoke, no Puppeteer) BEFORE Task 4. If user wants Puppeteer, add a Task 4.5 that installs `puppeteer` as a devDep and writes `extension/scripts/smoke.mjs`.
- Worktree skill: `superpowers:using-git-worktrees` for Task 0.
- Dirty-tree off-limits list (do not stage, do not commit, do not modify): `server/routes/gpu.js`, `server/services/gpu-failure-poller.js`, `check_placement.js`, `final_query*.js`, `query_*.js`, `server/db.sqlite`, `server/seed/update-*.js`, `docs/plans/2026-04-22-reset-broll-searches.md`, `docs/superpowers/plans/2026-04-22-db-pool-structural-fix.md`.

## File structure (Ext.10 final state)

```
.github/                              [NEW Ext.10]
└── workflows/
    └── extension-build.yml           [NEW Ext.10] GitHub Actions workflow

extension/
├── manifest.json                     unchanged (still 0.9.0)
├── config.js                         unchanged
├── service_worker.js                 unchanged
├── popup.html                        unchanged
├── popup.css                         unchanged
├── popup.js                          unchanged
├── README.md                         [MOD Ext.10] appended "Ext.10 — Build + CI" section
├── .extension-id                     unchanged (developer-only; excluded from dist)
├── modules/                          unchanged (all Ext.1-9 modules)
│   └── __tests__/                    unchanged (config-fetch, diagnostics tests; excluded from dist)
├── fixtures/                         unchanged (included in dist)
├── icons/                            unchanged (included in dist)
├── scripts/
│   ├── generate-key.mjs              unchanged (developer-only; excluded from dist)
│   ├── package.mjs                   [NEW Ext.10] Node packager script
│   └── __tests__/
│       └── package.test.js           [NEW Ext.10] ~5 tests
└── dist/                             [GIT-IGNORED] packager output

package.json                          [MOD Ext.10] +"ext:package" script
.gitignore                            [MOD Ext.10] +extension/scripts/*.log (dist/ already ignored)
```

Why this split:

- **`package.mjs` in `extension/scripts/`** co-locates with the existing `generate-key.mjs` (Ext.1's keygen utility) — single directory for developer-only scripts. Both are excluded from the distributed zip by the include-list.
- **`__tests__/` inside `scripts/`** matches Vitest's convention and mirrors `modules/__tests__/`. Tests do NOT ship (the include list names `modules/*.js` without `modules/__tests__/*`, and doesn't name `scripts/*` at all).
- **`.github/workflows/` at repo root** is the required GitHub Actions location. Zero flexibility — the workflow file MUST live there.
- **`extension-build.yml` named with `extension-` prefix** — when Ext.11 adds a Web Store submission workflow, it can live at `.github/workflows/extension-release.yml` without clashing.
- **`.gitignore` delta is tiny** because `extension/dist/` is already ignored (set up in a prior phase; verified at investigation). The only addition is `extension/scripts/*.log` for the packager's optional verbose log.

## Working conventions

- **Worktree.** All work happens in `.worktrees/extension-ext10` (branch `feature/extension-ext10-ci-packaging`) created off current `main` (HEAD `cd7d25f`). Use the `superpowers:using-git-worktrees` skill for Task 0. Do NOT work on `main` directly.
- **Never push.** No `git push origin` until the user confirms. Commits stay local. In particular, do NOT push a test tag like `ext-v0.9.0-test` to trigger the workflow — the workflow must first land on `main`, then the user triggers it manually via `workflow_dispatch` from the GitHub UI.
- **Never kill anything on `:3001`.** The backend is running and other phases need it. Ext.10 doesn't need the backend at all (the packager is offline), but don't accidentally kill it with a cleanup command.
- **Quote every path.** The repo lives at `/Users/laurynas/Desktop/one last /transcript-eval` — the trailing space in `"one last "` is load-bearing. Every bash invocation quotes the full path with double-quotes; heredocs use absolute paths; `cd` is used sparingly.
- **Never amend.** Always new commits, even after a pre-commit hook failure.
- **One commit per task.** Each `Task N` ends with exactly one commit (or zero, for the manual-smoke final task which is explicitly marked "DO NOT COMMIT"). Conventional-commit prefixes: `feat(extension):`, `chore(ci):`, `test(extension):`, `docs(extension):`.
- **Commit trailer.** Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **Dirty-tree off-limits.** See Prerequisites list above. These may appear as dirty in `git status`; leave them alone.
- **Investigate, don't guess.** Before writing the include-list in `package.mjs`, `ls -la extension/` + `ls -la extension/modules/` + `ls -la extension/fixtures/` to confirm the directory tree matches this plan. Before writing the workflow, `gh workflow list` is blocked (no push) — instead, cross-reference the workflow with `docs/specs/2026-04-23-envato-export-extension.md` § CI + § Distribution.

## Task 0: Create worktree + branch + scaffold commit

**Files:** none (git operations only).

- [ ] **Step 0.1: Verify clean enough tree.**
  ```bash
  git -C "/Users/laurynas/Desktop/one last /transcript-eval" status --short \
    | grep -vE '^(\?\?)|gpu|check_placement|final_query|query_|server/db\.sqlite|server/seed/update-|docs/plans/2026-04-22|docs/superpowers/plans/2026-04-22' \
    | head -20
  ```
  Output must be empty (only the known dirty-tree files present). If anything else is dirty, stop and ask the user.

- [ ] **Step 0.2: Verify Ext.9 baseline is merged.**
  ```bash
  git -C "/Users/laurynas/Desktop/one last /transcript-eval" log --oneline -5
  # Expect 8f18f78 (Ext.9 merge) in the last 5 commits; HEAD at cd7d25f or later.
  grep -n 'EXT_VERSION' "/Users/laurynas/Desktop/one last /transcript-eval/extension/config.js"
  # Expect EXT_VERSION = '0.9.0'
  grep -n '"version"' "/Users/laurynas/Desktop/one last /transcript-eval/extension/manifest.json"
  # Expect "version": "0.9.0"
  ```

- [ ] **Step 0.3: Confirm `fflate` runtime dep is present.**
  ```bash
  grep -n '"fflate"' "/Users/laurynas/Desktop/one last /transcript-eval/package.json"
  # Expect: "fflate": "^0.8.2" in dependencies (NOT devDependencies)
  ```
  If `fflate` is in `devDependencies` for some reason, stop and ask the user — it must be a runtime dep because `package.mjs` imports it and CI runs after `npm ci`.

- [ ] **Step 0.4: Confirm `.github/` does not yet exist.**
  ```bash
  ls -la "/Users/laurynas/Desktop/one last /transcript-eval/.github" 2>&1
  # Expect: "No such file or directory"
  ```
  If `.github/` exists unexpectedly (some prior phase created it), grep for existing workflows and coordinate with the user before clobbering.

- [ ] **Step 0.5: Confirm `extension/dist/` is already gitignored.**
  ```bash
  grep -n 'extension/dist' "/Users/laurynas/Desktop/one last /transcript-eval/.gitignore"
  # Expect: a line "extension/dist/" or "extension/dist"
  ```
  If missing, flag immediately — that's a load-bearing invariant. Executor adds it in Task 7 alongside the log-file ignore.

- [ ] **Step 0.6: Create worktree.** Invoke `superpowers:using-git-worktrees`. Target directory: `.worktrees/extension-ext10`. Branch name: `feature/extension-ext10-ci-packaging`. Base: `main`. The skill handles `git worktree add` + initial `cd`.

- [ ] **Step 0.7: Copy this plan into the worktree** so the executor has it within the working tree.
  ```bash
  cp "/Users/laurynas/Desktop/one last /transcript-eval/docs/superpowers/plans/2026-04-24-extension-ext10-ci-packaging.md" \
     "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10/docs/superpowers/plans/2026-04-24-extension-ext10-ci-packaging.md"
  ```

- [ ] **Step 0.8: Smoke build + baseline tests.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  npm ci 2>&1 | tail -20
  # node_modules populated
  npm run test 2>&1 | tail -20
  # 125/125 green
  ```

- [ ] **Step 0.9: Confirm `extension/scripts/` exists with `generate-key.mjs`.**
  ```bash
  ls -la extension/scripts/
  # Expect: generate-key.mjs present (Ext.1 keygen). No package.mjs yet.
  ```

- [ ] **Step 0.10: Scaffold commit.** Commits the plan copy into the worktree.
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  git add docs/superpowers/plans/2026-04-24-extension-ext10-ci-packaging.md
  git commit -m "$(cat <<'EOF'
  chore(extension): start Ext.10 CI packaging branch

  Scaffold commit with the Ext.10 plan copied into the worktree.
  Ext.10 ships the build + CI packaging pipeline: a Node packager
  (extension/scripts/package.mjs) + a GitHub Actions workflow
  (.github/workflows/extension-build.yml). No runtime behavior
  change; extension stays at v0.9.0.

  .crx signing + Web Store auto-submission + Puppeteer smoke are
  explicitly deferred per Open Questions 1-3.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

- [ ] **Step 0.11: Verify branch + worktree.**
  ```bash
  git -C "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10" branch --show-current
  # feature/extension-ext10-ci-packaging
  git -C "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10" log --oneline main..HEAD
  # exactly the scaffold commit
  ```

## Task 1: `package.mjs` skeleton + include list + CLI flag parsing

**Files:** `extension/scripts/package.mjs` [NEW].

> **BLOCKING:** Do NOT proceed until **Open Question 1** is answered. If user wants `.crx` in scope, insert Task 6.5 (CRX3 signing) before Task 7 and plumb a `--crx` flag into this skeleton now.

- [ ] **Step 1.1: Create `extension/scripts/package.mjs` with header + CLI + include-list constants.**
  Header block documents the include-list invariant (see `Why read this before touching code` item #2). CLI uses a minimal arg parser (no `commander`, no `yargs` — Node stdlib only; ~15 lines of manual `process.argv` parsing). Flags:
  - `--out <dir>` (default: `extension/dist`)
  - `--no-zip` (stage the dist tree but skip the zip step — test-harness mode)
  - `--verbose` (log each staged file)
  - `--help` (print usage + exit 0)

  Include-list constants (at top of file, frozen):
  ```js
  // Files at extension/ root that ship in the zip.
  const ROOT_INCLUDES = Object.freeze([
    'manifest.json',
    'service_worker.js',
    'config.js',
    'popup.html',
    'popup.css',
    'popup.js',
  ])

  // Directories at extension/ that ship — recursively copied,
  // minus patterns in DIR_EXCLUDES.
  const DIR_INCLUDES = Object.freeze(['modules', 'icons', 'fixtures'])

  // Patterns that are excluded even when inside a DIR_INCLUDES dir.
  // Tests, scratch files, OS junk, private keys must never ship.
  const DIR_EXCLUDES = Object.freeze([
    /(^|\/)__tests__(\/|$)/,
    /\.test\.(js|mjs)$/,
    /\.spec\.(js|mjs)$/,
    /\.log$/,
    /\.DS_Store$/,
    /(^|\/)\.private-key\.pem$/,
    /(^|\/)\.extension-id$/,
    /(^|\/)node_modules(\/|$)/,
  ])
  ```

- [ ] **Step 1.2: Implement `parseArgs(argv)`.** ~20 lines of stdlib-only argv parsing. Returns `{out, zip: boolean, verbose, help}`. Unknown flags → throw with a usage message.

- [ ] **Step 1.3: Implement `printUsage()`.** Prints the flag list + exits. Invoked on `--help` or unknown-flag error.

- [ ] **Step 1.4: Implement `main()` skeleton.** Parses args, loads manifest (version), logs the plan:
  ```
  [ext:package] Packaging transcript-eval extension v0.9.0
  [ext:package]   out = /abs/path/to/extension/dist
  [ext:package]   zip = true
  ```
  Does NOT yet do any filesystem work — Tasks 2+3 implement the stage + zip.

- [ ] **Step 1.5: Add `if (import.meta.url === ...)` guard.** So `package.mjs` runs when invoked as a script AND can be imported by tests without triggering `main()`.
  ```js
  import { fileURLToPath } from 'node:url'
  const isDirectRun = import.meta.url === `file://${process.argv[1]}`
  if (isDirectRun) {
    main().catch(err => { console.error('[ext:package]', err); process.exit(1) })
  }
  ```

- [ ] **Step 1.6: Verify script boots.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  node extension/scripts/package.mjs --help
  # Prints usage, exits 0.
  node extension/scripts/package.mjs --verbose
  # Prints "[ext:package] Packaging transcript-eval extension v0.9.0" + the out/zip/verbose lines, exits 0 (no stage yet).
  ```

- [ ] **Step 1.7: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  git add extension/scripts/package.mjs
  git commit -m "$(cat <<'EOF'
  feat(extension): package.mjs skeleton + CLI + include-list constants

  New extension/scripts/package.mjs. Stdlib-only arg parsing for
  --out, --no-zip, --verbose, --help. Include-list constants
  (ROOT_INCLUDES + DIR_INCLUDES + DIR_EXCLUDES regexes) are
  frozen at file top and load-bearing: adding a new runtime
  file to extension/ requires explicitly naming it here or it
  will NOT ship.

  Tasks 2 + 3 implement the stage + zip steps against these
  constants.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 2: Implement stage step (copy runtime files to `dist/`)

**Files:** `extension/scripts/package.mjs` [MOD].

- [ ] **Step 2.1: Implement `stageDist({ extRoot, outDir, verbose })`.** Async function, ~50 lines. Algorithm:
  1. Remove `outDir` if it exists (`fs.rm(outDir, { recursive: true, force: true })`).
  2. Recreate `outDir`.
  3. For each file in `ROOT_INCLUDES`: copy `${extRoot}/${file}` → `${outDir}/${file}`. Throw if source is missing.
  4. For each dir in `DIR_INCLUDES`: recursively walk `${extRoot}/${dir}`, copy each file whose path does NOT match any regex in `DIR_EXCLUDES`. Preserve directory structure.
  5. Return `{stagedCount, bytesTotal}`.

  The walk uses `fs.readdir(... , { withFileTypes: true, recursive: true })` (Node 20+) and is straightforward — ~30 lines.

- [ ] **Step 2.2: Wire `stageDist` into `main`.** After version logging, call `stageDist({...})` and log `[ext:package] Staged ${stagedCount} files (${bytes} bytes) -> ${outDir}`.

- [ ] **Step 2.3: Verify stage on real extension.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  rm -rf extension/dist
  node extension/scripts/package.mjs --no-zip --verbose 2>&1 | tail -40
  # Should log each staged file; count should roughly match:
  # - 6 root files (manifest, SW, config, popup x3)
  # - 10 modules/*.js (auth, classifier, config-fetch, diagnostics, envato, port, queue, sources, storage, telemetry)
  # - N icons (confirm with ls extension/icons/)
  # - M fixtures/ files (confirm with find extension/fixtures -type f)
  # NOT: .extension-id, README.md, scripts/, modules/__tests__/
  find extension/dist -type f | sort
  # Manually eyeball: no test files, no .extension-id, no README.
  ```

- [ ] **Step 2.4: Confirm exclude list fired correctly.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  find extension/dist -name '*.test.js' -o -name '__tests__' -o -name '.extension-id' -o -name 'README.md' -o -name 'generate-key.mjs'
  # Output must be empty.
  ```

- [ ] **Step 2.5: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  git add extension/scripts/package.mjs
  git commit -m "$(cat <<'EOF'
  feat(extension): package.mjs stageDist — copy runtime files to dist/

  Implements stageDist({extRoot, outDir, verbose}): wipes outDir,
  copies ROOT_INCLUDES verbatim, recursively walks DIR_INCLUDES
  (modules, icons, fixtures) while filtering DIR_EXCLUDES regexes
  (__tests__, .test.js, .log, .DS_Store, .private-key.pem,
  .extension-id, node_modules).

  --no-zip flag now produces a fully-staged dist/ tree without
  the zip step — this is the test harness mode consumed by
  Task 4's package.test.js.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 3: Implement zip step + sha256 log line

**Files:** `extension/scripts/package.mjs` [MOD].

- [ ] **Step 3.1: Import `fflate` at the top of `package.mjs`.**
  ```js
  import { zipSync } from 'fflate'
  import { createHash } from 'node:crypto'
  ```

- [ ] **Step 3.2: Implement `zipDist({ outDir, version })`.** ~30 lines. Algorithm:
  1. Walk `outDir` recursively, building `files = {}` where keys are POSIX paths relative to `outDir` and values are `Uint8Array` from `fs.readFile`.
  2. Invoke `zipSync(files, { level: 9, mtime: new Date(0) })` — force epoch-zero timestamps for determinism.
  3. Write the result to `${outDir}/extension-${version}.zip`.
  4. Compute sha256 of the zip bytes.
  5. Return `{zipPath, bytes, sha256}`.

- [ ] **Step 3.3: Wire `zipDist` into `main`** — skip when `--no-zip`. Log:
  ```
  [ext:package] Wrote extension-0.9.0.zip (N bytes, sha256=XXXXX)
  ```

- [ ] **Step 3.4: Verify determinism.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  rm -rf extension/dist
  node extension/scripts/package.mjs 2>&1 | tail -5
  # Capture sha256.
  SHA1=$(shasum -a 256 extension/dist/extension-0.9.0.zip | cut -d' ' -f1)
  rm -rf extension/dist
  node extension/scripts/package.mjs 2>&1 | tail -5
  SHA2=$(shasum -a 256 extension/dist/extension-0.9.0.zip | cut -d' ' -f1)
  [ "$SHA1" = "$SHA2" ] && echo "deterministic" || echo "DRIFT: $SHA1 != $SHA2"
  # Must print "deterministic".
  ```
  If this prints "DRIFT", investigate `fflate`'s `mtime` option (may need to pass `mtime: 0` as a number, not a Date). Determinism is a load-bearing invariant; do not commit until it's stable.

- [ ] **Step 3.5: Sanity-check the zip contents.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  unzip -l extension/dist/extension-0.9.0.zip | head -40
  # Should list manifest.json first, then SW, then popup, then modules/*, then icons/*, then fixtures/*.
  # Should NOT list .extension-id, README.md, __tests__/, scripts/.
  ```

- [ ] **Step 3.6: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  git add extension/scripts/package.mjs
  git commit -m "$(cat <<'EOF'
  feat(extension): package.mjs zipDist — deterministic zip via fflate

  Implements zipDist({outDir, version}): walks the staged dist/,
  zips via fflate.zipSync with level 9 + epoch-zero mtime for
  deterministic output. Logs sha256 of the final zip so a byte
  drift across CI runs is loud.

  Running package.mjs twice on the same inputs now produces a
  byte-identical zip. This is load-bearing — the Web Store
  fingerprints uploads, and Ext.11's eventual automated-upload
  flow relies on a stable sha256 for diffing.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 4: Tests — `extension/scripts/__tests__/package.test.js`

**Files:** `extension/scripts/__tests__/package.test.js` [NEW].

> **BLOCKING:** Do NOT proceed until **Open Question 2** is answered. If user wants Puppeteer smoke, insert Task 4.5 (smoke.mjs + puppeteer devDep) before Task 5.

- [ ] **Step 4.1: Create `extension/scripts/__tests__/package.test.js`.** Vitest + `child_process.spawnSync` + tmp dir. ~5 tests. Skeleton:
  ```js
  import { describe, it, expect, beforeEach, afterEach } from 'vitest'
  import { spawnSync } from 'node:child_process'
  import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'

  const REPO_ROOT = new URL('../../../', import.meta.url).pathname
  const SCRIPT = join(REPO_ROOT, 'extension', 'scripts', 'package.mjs')

  function runPackager(args) {
    return spawnSync('node', [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    })
  }

  describe('package.mjs', () => {
    let tmpOut
    beforeEach(() => { tmpOut = mkdtempSync(join(tmpdir(), 'ext-pkg-')) })
    afterEach(() => { rmSync(tmpOut, { recursive: true, force: true }) })

    it('exits 0 with --help', () => { ... })

    it('stages manifest + SW + modules into --out on --no-zip', () => { ... })

    it('excludes __tests__/, .extension-id, README.md, scripts/', () => { ... })

    it('produces a zip at extension-${version}.zip when --zip', () => { ... })

    it('is deterministic — two runs produce byte-identical zips', () => { ... })
  })
  ```

- [ ] **Step 4.2: Fill in test bodies.** Each test invokes `runPackager(['--no-zip', '--out', tmpOut])` (or `--out` + zip), then asserts the file tree. Use `existsSync` + `readdirSync` for presence/absence; use `readFileSync` + hash-compare for determinism.

  - **Test: help.** `runPackager(['--help'])` → `status === 0`, stdout contains `--out` and `--no-zip`.
  - **Test: stage.** `runPackager(['--no-zip', '--out', tmpOut])` → `status === 0`, `existsSync(join(tmpOut, 'manifest.json'))`, `existsSync(join(tmpOut, 'service_worker.js'))`, `existsSync(join(tmpOut, 'modules', 'config-fetch.js'))`.
  - **Test: excludes.** Same invocation → `!existsSync(join(tmpOut, '.extension-id'))`, `!existsSync(join(tmpOut, 'README.md'))`, `!existsSync(join(tmpOut, 'modules', '__tests__'))`, `!existsSync(join(tmpOut, 'scripts'))`.
  - **Test: zip produced.** `runPackager(['--out', tmpOut])` → `status === 0`, `existsSync(join(tmpOut, 'extension-0.9.0.zip'))`, zip is non-empty.
  - **Test: determinism.** Run twice into two separate tmp dirs, sha256-compare the two zip files → equal.

- [ ] **Step 4.3: Confirm tests run via vitest workspace config.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  npm run test -- extension/scripts/__tests__/package.test.js 2>&1 | tail -30
  # 5 passing
  ```
  If vitest does not pick up the new path (e.g., workspace config only covers `extension/modules/__tests__/` + app tests), add `extension/scripts/__tests__/*.test.js` to whichever `vitest.config.*` or `vite.config.*` include glob governs the extension test project. Greppable at `vitest.config`, `vite.config`, or `package.json` `test` script.

- [ ] **Step 4.4: Verify full test suite still green.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  npm run test 2>&1 | tail -10
  # 130/130 (125 baseline + 5 new)
  ```

- [ ] **Step 4.5: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  git add extension/scripts/__tests__/package.test.js
  # plus vitest/vite config if modified
  git commit -m "$(cat <<'EOF'
  test(extension): package.test.js — 5 tests covering stage + zip + excludes

  Vitest invokes package.mjs via child_process.spawnSync into
  a tmp dir. Covers:

  - --help exits 0 with usage output
  - --no-zip stages manifest + SW + modules/config-fetch.js
  - Excludes fire: no .extension-id, README.md, __tests__/, scripts/
  - --zip (default) produces extension-0.9.0.zip
  - Determinism: two runs produce byte-identical zips

  The exclude coverage is the load-bearing test — a future
  developer adding a debug file to extension/ will fail this
  suite if they don't also update ROOT_INCLUDES / DIR_INCLUDES.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 5: `package.json` script entry

**Files:** `package.json` [MOD].

- [ ] **Step 5.1: Add `"ext:package"` to scripts block.**
  Insert after the existing `"ext:generate-key"` entry:
  ```json
      "ext:package": "node extension/scripts/package.mjs"
  ```
  (No trailing comma handling — `ext:generate-key` is the last current entry, so add a comma after its value and append `ext:package` on the next line.)

- [ ] **Step 5.2: Verify.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  npm run ext:package 2>&1 | tail -10
  # [ext:package] Wrote extension-0.9.0.zip (...)
  rm -rf extension/dist
  ```

- [ ] **Step 5.3: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  git add package.json
  git commit -m "$(cat <<'EOF'
  chore(extension): add npm run ext:package script

  Wires package.mjs into package.json scripts. Run locally to
  produce extension/dist/extension-0.9.0.zip; the GitHub Actions
  workflow (landing next) runs the same script in CI.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 6: GitHub Actions workflow — `.github/workflows/extension-build.yml`

**Files:** `.github/workflows/extension-build.yml` [NEW], `.github/` [NEW directory].

> **BLOCKING:** Do NOT proceed until **Open Question 2** is answered. The `validate-dist` step depends on the answer — if user picks Puppeteer, this step is replaced; if user picks neither, this step is omitted.

- [ ] **Step 6.1: Create `.github/workflows/extension-build.yml`.** Full workflow body below. Targets: Ubuntu latest; Node 20; runs on push-to-main (path filter), tag `ext-v*`, and `workflow_dispatch`. Two jobs: `build` (all triggers) and `release` (tag only, needs `build`).

  ```yaml
  name: Extension Build

  on:
    push:
      branches: [main]
      paths:
        - 'extension/**'
        - '.github/workflows/extension-build.yml'
        - 'package.json'
        - 'package-lock.json'
      tags:
        - 'ext-v*'
    workflow_dispatch:

  permissions:
    contents: write  # for softprops/action-gh-release on tag

  jobs:
    build:
      runs-on: ubuntu-latest
      steps:
        - name: Checkout
          uses: actions/checkout@v4

        - name: Setup Node 20
          uses: actions/setup-node@v4
          with:
            node-version: '20'
            cache: 'npm'

        - name: Install deps
          run: npm ci

        - name: Package extension
          run: npm run ext:package

        - name: Validate dist
          run: |
            set -euo pipefail
            cd extension/dist
            VERSION=$(node -p "require('../manifest.json').version")
            echo "Expected zip: extension-${VERSION}.zip"
            [ -f "extension-${VERSION}.zip" ] || (echo "::error::Zip not found" && exit 1)
            rm -rf verify && mkdir verify && unzip -q "extension-${VERSION}.zip" -d verify
            node -e "
              const m = require('./verify/manifest.json');
              if (m.manifest_version !== 3) { console.error('manifest_version !== 3'); process.exit(1); }
              if (m.version !== '${VERSION}') { console.error('version mismatch'); process.exit(1); }
              if (!m.background || !m.background.service_worker) { console.error('missing service_worker'); process.exit(1); }
              if (!m.key) { console.error('missing manifest key (Ext.1 pin)'); process.exit(1); }
              if (!Array.isArray(m.permissions) || m.permissions.length < 4) { console.error('permissions shrunk unexpectedly'); process.exit(1); }
              console.log('[validate-dist] manifest OK, version=' + m.version);
            "
            for f in service_worker.js popup.html popup.js config.js modules/auth.js modules/config-fetch.js modules/diagnostics.js icons/icon-128.png; do
              [ -f "verify/$f" ] || (echo "::error::Missing $f in dist zip" && exit 1)
            done
            for bad in .extension-id README.md modules/__tests__ scripts; do
              [ ! -e "verify/$bad" ] || (echo "::error::Excluded path $bad leaked into dist" && exit 1)
            done
            echo "[validate-dist] include + exclude checks passed"
            rm -rf verify

        - name: Upload build artifact
          uses: actions/upload-artifact@v4
          with:
            name: extension-zip
            path: extension/dist/extension-*.zip
            retention-days: 90

    release:
      needs: build
      runs-on: ubuntu-latest
      if: startsWith(github.ref, 'refs/tags/ext-v')
      steps:
        - name: Download artifact
          uses: actions/download-artifact@v4
          with:
            name: extension-zip
            path: dist

        - name: Publish GitHub Release
          uses: softprops/action-gh-release@v2
          with:
            files: dist/extension-*.zip
            generate_release_notes: true
            fail_on_unmatched_files: true
  ```

  **Note on `icons/icon-128.png`** in the validate-dist include check: confirm at Task 6 whether this file exists (`ls extension/icons/`). If the actual icon filenames differ (e.g., `128.png` or `icon128.png`), swap the check to the real filename. The check must name a file that definitely exists in the current tree — otherwise it becomes a false-positive failure.

- [ ] **Step 6.2: Verify YAML syntax locally.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  # If `yq` or `python3 -c 'import yaml'` available:
  python3 -c "import yaml; yaml.safe_load(open('.github/workflows/extension-build.yml'))" && echo "YAML OK"
  ```
  If YAML tooling unavailable, eyeball-check indentation carefully. A broken workflow will not fail the merge but will fail on first push.

- [ ] **Step 6.3: Dry-run the validate-dist logic locally.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  rm -rf extension/dist
  npm run ext:package
  # Now replicate the workflow's validate-dist step manually:
  cd extension/dist
  VERSION=$(node -p "require('../manifest.json').version")
  rm -rf verify && mkdir verify && unzip -q "extension-${VERSION}.zip" -d verify
  # ... run the same node -e + for loops from the workflow
  ```
  Everything must pass. If anything fails, fix it here (include-list drift, icon filename mismatch) — NOT in CI.

- [ ] **Step 6.4: Confirm icon filenames match the validate-dist check.**
  ```bash
  ls extension/icons/
  ```
  Adjust the `for f in ...` line in the workflow if the actual icon name differs from `icon-128.png`.

- [ ] **Step 6.5: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  git add .github/workflows/extension-build.yml
  git commit -m "$(cat <<'EOF'
  chore(ci): GitHub Actions workflow for extension build + release

  New .github/workflows/extension-build.yml. Ubuntu-latest +
  Node 20. Triggers:
  - push to main when extension/** changes → build + upload
    workflow-run artifact (90-day retention)
  - tag ext-v* → build + publish GitHub Release with zip
  - workflow_dispatch → on-demand build

  validate-dist step unzips the built archive in CI and asserts:
  - manifest parses, version matches, manifest_version === 3
  - key field present (Ext.1 pin); permissions array non-shrunk
  - runtime files present: SW, popup, config, 3 modules, icons
  - excluded paths absent: .extension-id, README.md, __tests__/, scripts/

  No .crx signing (deferred per Open Question 1). No Puppeteer
  smoke (deferred per Open Question 2). No Web Store submission
  (Ext.11).

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 7: `.gitignore` — add log file ignore

**Files:** `.gitignore` [MOD].

- [ ] **Step 7.1: Confirm `extension/dist/` is already present.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  grep -n 'extension/dist' .gitignore
  # Expect: "extension/dist/" already listed in the "# Extension dev artifacts" block.
  ```
  If missing, add it FIRST before anything else — it's load-bearing.

- [ ] **Step 7.2: Append `extension/scripts/*.log` to the extension dev artifacts block.**
  Under the existing `# Extension dev artifacts` comment:
  ```
  # Extension dev artifacts
  .secrets/
  extension/dist/
  extension/scripts/*.log
  ```

- [ ] **Step 7.3: Verify.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  # Create a sentinel log, confirm git ignores it:
  touch extension/scripts/test-ignore.log
  git status --short | grep -E 'scripts/.*\.log' && echo "LEAK" || echo "ignored"
  # Must print "ignored".
  rm extension/scripts/test-ignore.log
  ```

- [ ] **Step 7.4: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  git add .gitignore
  git commit -m "$(cat <<'EOF'
  chore(extension): gitignore packager log files

  Appends extension/scripts/*.log to the dev-artifacts block so
  a verbose packager run's optional log output does not leak
  into git status. extension/dist/ was already ignored from an
  earlier phase; no change there.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 8: README — Ext.10 Build + CI section + cross-browser table

**Files:** `extension/README.md` [MOD].

- [ ] **Step 8.1: Append section at the end of `extension/README.md`.** Content:

  ```markdown
  ---

  ## Ext.10 — Build + CI

  ### Package the extension locally

  ```bash
  npm run ext:package
  # → extension/dist/extension-0.9.0.zip
  ```

  The script (`extension/scripts/package.mjs`) is deterministic — two runs
  on the same inputs produce a byte-identical zip. It uses an include-list,
  not an exclude-list: adding a new runtime file to `extension/` requires
  updating `ROOT_INCLUDES` or `DIR_INCLUDES` in `package.mjs` or the file
  will NOT ship. Developer-only files (`scripts/`, `README.md`,
  `.extension-id`, `modules/__tests__/`, `.private-key.pem`) are excluded
  unconditionally.

  Flags:
  - `--out <dir>` — output directory (default `extension/dist`)
  - `--no-zip` — stage the dist tree but skip the zip step (test harness)
  - `--verbose` — log each staged file

  ### GitHub Actions workflow

  `.github/workflows/extension-build.yml` runs on:

  | Trigger | Behavior |
  |---------|----------|
  | Push to `main` touching `extension/**` | Build + upload workflow-run artifact (90-day retention) |
  | Tag `ext-v*` (e.g. `ext-v0.9.0`) | Build + publish GitHub Release with `.zip` attached |
  | `workflow_dispatch` (manual) | Build + upload workflow-run artifact |

  The `validate-dist` step in CI unzips the built archive and asserts the
  manifest parses, runtime files are present, and excluded paths are
  absent. Failure at this step means the include-list drifted — fix
  `package.mjs`, not the workflow.

  ### Cut a tagged release

  ```bash
  # From main, with the desired commit checked out:
  git tag ext-v0.9.0
  git push origin ext-v0.9.0
  # Workflow fires, builds, publishes GitHub Release with the zip.
  ```

  Tag format is `ext-v<semver>` (NOT `v<semver>`) so extension releases
  don't collide with future app-wide version tags.

  ### Cross-browser compatibility

  | Browser | Status | Notes |
  |---------|--------|-------|
  | Chrome 120+ | Primary | Manifest `minimum_chrome_version: "120"` enforces. |
  | Microsoft Edge | Supported | Chromium-based; same extension package works. |
  | Arc | Best-effort | Chromium-based; untested in CI. |
  | Brave | Best-effort | Strict tracker-blocking may block `/api/export-events` beacons on Envato pages. Non-fatal. |
  | Vivaldi | Best-effort | Chromium-based; untested in CI. |
  | Opera | Best-effort | Chromium-based; untested in CI. |
  | Firefox | Out of scope | Manifest V3 incompatibilities + different WebExtensions API quirks. |
  | Safari | Out of scope | Separate Safari Web Extensions pipeline required. |
  | Chrome Enterprise / managed policies | May block install | Corporate users need IT approval. Documented, not engineered around. |
  | Chromebook | Untested | Disk layout differs; treat as unsupported until tested. |

  ### Deferred

  - **`.crx` signing + self-hosted distribution** — future Ext.10.5 mini-PR.
  - **Chrome Web Store auto-submission on tag** — Ext.11 (submission phase).
  - **Puppeteer-driven headless browser smoke** — future phase if beta
    surfaces undetected MV3 loading bugs.
  - **Canary channel / second Web Store listing** — Ext.12.
  ```

- [ ] **Step 8.2: Verify the cross-browser table renders.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  cat extension/README.md | tail -80
  # Eyeball: table pipes align, code blocks open/close.
  ```

- [ ] **Step 8.3: Commit.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  git add extension/README.md
  git commit -m "$(cat <<'EOF'
  docs(extension): README - Ext.10 build + CI section

  Documents npm run ext:package (local), the GitHub Actions
  workflow (push-to-main, tag, workflow_dispatch), and the
  cut-a-tagged-release flow. Adds the cross-browser
  compatibility table: Chrome 120+ primary; Edge supported;
  Arc / Brave / Vivaldi / Opera best-effort; Firefox + Safari
  explicitly out of scope; Chromebook untested.

  Notes the deferred items (.crx, Web Store auto-submit,
  Puppeteer, canary) so future-phase readers know where the
  line was drawn.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## Task 9: Final verification — full suite + local packager run

**Files:** none (verification only — NO COMMIT).

- [ ] **Step 9.1: Run the full test suite.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  npm run test 2>&1 | tail -15
  # Expect 130/130 (125 baseline + 5 new).
  ```

- [ ] **Step 9.2: Run the packager end-to-end.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  rm -rf extension/dist
  npm run ext:package 2>&1 | tail -10
  ls -la extension/dist/
  # Expect: extension-0.9.0.zip + unzipped dist dir.
  ```

- [ ] **Step 9.3: Inspect the zip.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  unzip -l extension/dist/extension-0.9.0.zip
  # Eyeball: manifest, SW, popup, modules/*, icons/*, fixtures/*. No .extension-id. No README. No scripts/. No __tests__/.
  ```

- [ ] **Step 9.4: Verify manifest parses inside the zip.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  rm -rf extension/dist/verify
  mkdir extension/dist/verify
  unzip -q extension/dist/extension-0.9.0.zip -d extension/dist/verify
  node -e "const m = require('$(pwd)/extension/dist/verify/manifest.json'); console.log(m.version, m.manifest_version, m.permissions.length, !!m.key)"
  # Expect: 0.9.0 3 6 true
  rm -rf extension/dist/verify
  ```

- [ ] **Step 9.5: Branch log check.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  git log --oneline main..HEAD
  # Expect 8 commits: scaffold + Tasks 1-8.
  ```

  Commits in order:
  1. `chore(extension): start Ext.10 CI packaging branch` (Task 0)
  2. `feat(extension): package.mjs skeleton + CLI + include-list constants` (Task 1)
  3. `feat(extension): package.mjs stageDist — copy runtime files to dist/` (Task 2)
  4. `feat(extension): package.mjs zipDist — deterministic zip via fflate` (Task 3)
  5. `test(extension): package.test.js — 5 tests covering stage + zip + excludes` (Task 4)
  6. `chore(extension): add npm run ext:package script` (Task 5)
  7. `chore(ci): GitHub Actions workflow for extension build + release` (Task 6)
  8. `chore(extension): gitignore packager log files` (Task 7)
  9. `docs(extension): README - Ext.10 build + CI section` (Task 8)

  (That's 9, not 8 — recount. Accept either count; executor reports the actual number.)

## Task 10: Manual smoke — load zip into Chrome (NO COMMIT)

**Files:** none (manual verification only).

This is the confidence check before merge. Do NOT commit anything.

- [ ] **Step 10.1: Run `npm run ext:package`.** Observe output:
  ```
  [ext:package] Packaging transcript-eval extension v0.9.0
  [ext:package] Staged N files (M bytes) -> .../extension/dist
  [ext:package] Wrote extension-0.9.0.zip (K bytes, sha256=...)
  ```

- [ ] **Step 10.2: Unzip the produced archive to a scratch dir.**
  ```bash
  cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10"
  mkdir -p /tmp/ext-smoke
  rm -rf /tmp/ext-smoke/*
  unzip -q extension/dist/extension-0.9.0.zip -d /tmp/ext-smoke
  ls /tmp/ext-smoke
  # Expect: manifest.json, service_worker.js, config.js, popup.{html,css,js}, modules/, icons/, fixtures/
  ```

- [ ] **Step 10.3: Load unpacked into Chrome.**
  - Open `chrome://extensions` → enable Developer mode.
  - Remove any existing "transcript-eval Export Helper" unpacked extension.
  - Click "Load unpacked" → select `/tmp/ext-smoke`.
  - Confirm the extension loads without errors. Version reads `0.9.0`. Extension ID should match `extension/.extension-id` (load-bearing — confirms `"key"` field is intact in the zipped manifest).

- [ ] **Step 10.4: Popup + ping smoke.**
  - Click the extension toolbar icon. Popup opens.
  - Open the SW inspector (chrome://extensions → "service worker" link → DevTools).
  - From the web app at `http://localhost:5173`, run in the console:
    ```js
    chrome.runtime.sendMessage('<extension-id>', { type: 'ping' }, r => console.log(r))
    // Expect: { ok: true, ... pong response ...}
    ```
  - Confirm pong round-trips.

- [ ] **Step 10.5: Verify excludes didn't leak.**
  ```bash
  ls /tmp/ext-smoke/.extension-id 2>&1 | head -1
  # Expect: "No such file or directory"
  ls /tmp/ext-smoke/README.md 2>&1 | head -1
  # Expect: "No such file or directory"
  ls /tmp/ext-smoke/scripts/ 2>&1 | head -1
  # Expect: "No such file or directory"
  find /tmp/ext-smoke -name '*.test.js'
  # Expect: empty output
  ```

- [ ] **Step 10.6: Cleanup smoke artifacts.**
  ```bash
  rm -rf /tmp/ext-smoke
  rm -rf "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext10/extension/dist"
  # dist is gitignored; removing keeps the worktree tidy.
  ```

- [ ] **Step 10.7: Remove the dev unpacked extension in Chrome.** So subsequent dev sessions don't double-load.

- [ ] **Step 10.8: Record smoke output.** In the merge PR description (or task tracker): paste the `[ext:package] Wrote extension-0.9.0.zip (K bytes, sha256=HEX)` line and confirm which sha256 you observed. This is the reference value future reproducible-build investigations will compare against.

- [ ] **Step 10.9: Leave smoke artifacts uncommitted.** No git changes this task.

---

## Cross-phase notes

- **Ext.11 consumes the `.zip`.** When Ext.11 lands the Chrome Web Store submission flow, it will either (a) upload `extension/dist/extension-${VERSION}.zip` via `chromewebstore-upload-cli` in a new workflow or (b) download the release asset from a prior `ext-v<semver>` tag. Either way, Ext.10's artifact is the ONLY source of truth. Ext.11 MUST NOT re-package independently.
- **Ext.10.5 (future) — `.crx` signing.** If self-hosted distribution becomes a requirement (e.g., enterprise beta), a mini-PR adds `--crx` to `package.mjs`: reads `EXTENSION_PRIVATE_KEY` env var (base64-encoded PEM) or `extension/.private-key.pem` file, signs a CRX3 payload, emits `dist/extension-${version}.crx`. Tag-push release job then uploads both `.zip` AND `.crx`. The CI secret `EXTENSION_PRIVATE_KEY` is set by the user in GitHub Actions secrets.
- **Ext.12 — canary channel.** A second Web Store listing + `channel: "canary"` flag. Ext.10's single-workflow design accommodates this: either add a second workflow for the canary listing, or parameterize the existing workflow with `matrix.channel: [stable, canary]`. Decide at Ext.12.
- **Branch protection.** Ext.10 does NOT add `Extension Build` to required status checks. The user flips that in GitHub repo settings once the workflow has been green for a week. Document this as a post-merge TODO in the merge PR.
- **Artifact retention.** Workflow-run artifacts expire at 90 days (GitHub default); tagged-release assets are permanent. If the user needs workflow-run artifacts to persist longer (e.g., 365 days), override `retention-days` in the `upload-artifact@v4` step. Flagged only; no change in this plan.
- **`fflate` version lock.** The `package-lock.json` pins `fflate` to a specific version. If a future dep bump changes `fflate`'s zip output (unlikely — it's a mature, frozen library), determinism may drift. Ext.10's Task 4 determinism test catches this before merge.
- **Spec anchors.** This plan implements:
  - `docs/specs/2026-04-23-envato-export-extension.md` § "CI" (approximately lines 599-603)
  - `docs/specs/2026-04-23-envato-export-extension.md` § "Distribution" (approximately lines 608-643)
  - `docs/specs/2026-04-23-envato-export-extension.md` § "Cross-browser" (approximately lines 677-682)
  - `docs/specs/2026-04-24-export-remaining-roadmap.md` § "Ext.10 — Cross-browser + CI" (approximately lines 382-402)
- Any deviation from those anchors is flagged in this plan's § Scope or § Deferred.
