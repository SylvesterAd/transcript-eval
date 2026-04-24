# Context Brief — Chrome Extension Build Session

> Paste this as the opening message of a new Claude Code session. It contains everything needed to start building the Chrome extension ("transcript-eval Export Helper") without re-discovering context that already exists.

---

## Your mission

Build the Chrome MV3 extension that downloads licensed b-roll files to the user's disk during an export run. The extension is the final (Stage 4) surface of a 4-stage b-roll pipeline. Backend and upstream stages are already (or being) built — the extension plugs into an existing contract.

**Primary spec to follow:**
`/Users/laurynas/Desktop/one last /transcript-eval/docs/specs/2026-04-23-envato-export-extension.md`

Read it first. It has all the endpoint shapes, message protocols, state machines, and phase breakdowns. Everything below is context around that spec.

---

## Project topology

Three projects are involved. Two exist; one (the extension) is what you'll create.

| # | Project | Path | Role | Status |
|---|---|---|---|---|
| 1 | **transcript-eval** | `/Users/laurynas/Desktop/one last /transcript-eval/` | Editor web app + backend. Owns Supabase schema, the export HTTP endpoints, and the editor UI. | Phase 1 backend shipped on branch `feature/envato-export-phase1` (13 commits, not merged to main yet, not pushed). |
| 2 | **adpunk.ssh** | `/Users/laurynas/Documents/Adpunk.Ssh/` | GPU machine manager + scraping/ranking pipeline. Owns Stages 1-3 of the b-roll funnel (scrape candidates → SigLIP rank → Qwen video rerank). | Freepik/Pexels/Storyblocks search clients exist. Envato scraper + Oxylabs proxy pool still to be built — user is actively working on this in a separate Claude Code session in another terminal. |
| 3 | **Extension** | **You decide — see "Where to put the extension" below** | Chrome MV3 extension. This spec's scope. | Not started. |

**CRITICAL:** Path `/Users/laurynas/Desktop/one last /transcript-eval/` contains a **trailing space** in `one last `. Quote every path. `cd "$TE"` patterns, never bare.

---

## Where to put the extension

The spec doesn't pin this. Two reasonable options:

**A. Inside transcript-eval:** `/Users/laurynas/Desktop/one last /transcript-eval/extension/`. Pros: one repo for everything transcript-eval product-related; CI can build web + ext together; manifest-ID-to-web-app-config stays in sync. Cons: Chrome Web Store needs its own versioning; mixing Node/React with a vanilla-JS extension is mildly awkward.

**B. Separate repo:** e.g. `/Users/laurynas/Desktop/one last /transcript-eval-ext/`. Pros: clean separation; independent release cadence; `.crx` build independent of web app. Cons: two places to coordinate, JWT + message contract must stay in sync manually.

**Recommendation:** Option A for MVP. Can split later if versioning pain emerges. **Ask the user which they want before scaffolding.**

---

## Current state — what's shipped, what's in flight

### Shipped (transcript-eval Phase 1 backend)

Branch: `feature/envato-export-phase1` in `/Users/laurynas/Desktop/one last /transcript-eval/`. Worktree at `.worktrees/envato-export-phase1/`. 13 commits ahead of main; local only (not pushed to origin — user wants to merge after all 3 projects are ready).

**What you can call:**

| Method + Path | Purpose |
|---|---|
| `POST /api/session-token` | Web app requests 8h extension JWT. You never call this directly — the web app forwards the result to you. |
| `POST /api/exports` | Web app creates an export record. You never call this directly — the web app puts the returned `export_id` into the manifest it sends you. |
| `POST /api/export-events` | **YOUR primary write path.** Bearer JWT required. Stream telemetry. |
| `POST /api/pexels-url` | **YOUR Pexels download URL proxy.** Bearer JWT. |
| `POST /api/freepik-url` | **YOUR Freepik signed URL proxy.** Bearer JWT. Billable €0.05/call — dedupe per item per run. |

Exact request/response shapes, allowed event values, error codes: section "Integration with Phase 1 (already shipped)" in the extension spec.

**DB tables you care about (read-only for you; the web app reads these to build the manifest):**
- `exports` (one row per user-triggered export — `exp_<ULID>` id with `exp_` prefix).
- `export_events` (events you POST land here).
- `broll_searches.results_json` (JSON column — populated by adpunk.ssh, consumed by the web app to build the manifest it sends to you via `{type: "export"}`).

### In flight (adpunk.ssh)

Spec: `/Users/laurynas/Documents/Adpunk.Ssh/docs/superpowers/specs/2026-04-23-broll-candidate-pipeline.md`

User is implementing this in a separate Claude session right now. You do NOT interact with adpunk.ssh. Your only touchpoint is the `broll_searches.results_json` schema that adpunk.ssh writes — which the web app reads to construct the manifest you receive. That schema is:

```jsonc
{
  "source":           "envato" | "pexels" | "freepik" | "storyblocks",
  "source_item_id":   "<id>",
  "envato_item_url":  "https://elements.envato.com/...",  // envato only
  "poster_url":       "https://...",
  "preview_url":      "https://...",
  "resolution":       { "width": 1920, "height": 1080 },
  "duration_seconds": 8.3,
  "frame_rate":       30,
  "est_size_bytes":   150000000,
  "rank_score":       0.87,
  "rank_method":      "siglip+qwen"
}
```

Storyblocks items enter the pool but are flagged non-exportable — show a tooltip, skip in downloads.

### Not started (your scope)

The extension itself. Follow the spec's phased delivery: Ext.1 (MV3 skeleton + JWT round-trip) through Ext.12 (GA). Don't try to ship everything at once.

---

## Integration contracts — the non-negotiables

### 1. Backend is already live

Endpoints are shipped in Phase 1. Do not redesign them. If you need something they don't provide (e.g. `GET /api/ext-config` for feature flags), that's a backend change — file it as an open question rather than hacking around in the extension.

### 2. Web app ↔ extension messaging

One-shot via `chrome.runtime.sendMessage`, long-lived via `chrome.runtime.Port`. All messages versioned. See the spec's "Web app ↔ extension messaging" section for the schema.

### 3. Manifest comes from the web app, NOT from you

You never fetch `broll_searches` yourself. The web app reads it, builds the manifest, and sends it to you via `{type: "export"}`. Source of truth for candidate data lives in the transcript-eval web app, not in your extension.

### 4. XMEML generation is NOT yours

Server-side, `server/services/xmeml-generator.js`, built in a future phase. You just download files and record telemetry. The web app calls the XMEML generator after your `{type: "complete"}` Port message.

---

## User preferences (from prior sessions)

These are hard rules the user has set:

- **Investigate; don't guess.** When something's unclear, read the relevant code or spec rather than inventing an answer.
- **Don't push without asking.** `git push` requires explicit consent. `git commit` is fine.
- **Don't kill the user's dev server.** User runs their editor dev server on port 3001. `pkill -f server/index.js` matches their process — use `PORT=3002` for anything you launch, capture the PID, `kill $PID`.
- **Quote paths** — trailing space in `one last ` breaks unquoted shell expansion.
- **Use real verification** — this repo has no test framework. Task 9 of Phase 1 was an end-to-end curl smoke. Follow the same pattern: curl + DB inspection. Don't try to install Vitest for the backend.

---

## Environment + infrastructure

### Env vars you need (in extension-appropriate form)

The extension runs in the browser, not on a server, so it doesn't read `.env`. Config is compiled into the extension at build time OR fetched from the backend at runtime.

**Build-time config (`extension/src/config.js` or similar):**
- `BACKEND_URL` — `http://localhost:3001` (dev) / `https://backend-production-4b19.up.railway.app` (prod) / `https://transcript-eval.com` (future).
- `ENV` — `dev` | `prod` — enables mock mode when `dev`.

**Backend env vars that affect you (already set, you don't manage them):**
- `EXT_JWT_CURRENT_KID`, `EXT_JWT_KEYS` — backend's JWT signing keyring. Your concern only indirectly: your tokens carry `kid` matching the current signing key, and rotation still lets old tokens verify until their `exp`.
- `FREEPIK_API_KEY` — if blank, `/api/freepik-url` returns 503. Extension should emit `error_code: freepik_unconfigured` for the affected items and continue the run.
- `SLACK_WEBHOOK_URL` — shared alert channel. Backend fires Slack alerts when you post `item_failed` with `envato_403`/`envato_429` or `session_expired` (60s dedupe per `(user_id, event, error_code)` — you don't need to dedupe client-side).

### Deployments

- **Backend** — Railway (auto-deploys on push to `main`). Don't push until the user OKs merging `feature/envato-export-phase1`.
- **Frontend** — Vercel (auto-deploys on push to `main`; unsigned commits may be cancelled automatically).
- **Extension** — Chrome Web Store (manual submission, $5 one-time fee; Chrome API supports automated updates but initial upload is manual).
- **Adpunk.ssh** — Vast.ai GPU machines + Railway proxy.

### Shared infrastructure

- Supabase Postgres (`DATABASE_URL` in the backend env) — shared read surface between transcript-eval backend and adpunk.ssh.
- Slack webhook — shared alert channel for both backend and adpunk.ssh failures.
- API keys for Pexels / Freepik / Storyblocks — stored server-side only; extension NEVER holds these.

---

## Working conventions (borrowed from the Phase 1 session)

1. **Use superpowers skills.** The user runs via the superpowers plugin. Typical flow for a feature build:
   - `superpowers:brainstorming` (if requirements unclear)
   - `superpowers:writing-plans` (turn the spec into a task-by-task implementation plan)
   - `superpowers:using-git-worktrees` (create an isolated worktree before starting)
   - `superpowers:subagent-driven-development` (execute the plan task-by-task with spec + code reviews)
   - `superpowers:finishing-a-development-branch` (present merge/PR/keep/discard options when done)

2. **Plans live in `docs/superpowers/plans/` with date-prefixed filenames.** Specs live in `docs/specs/`. Both conventions are in use in both repos.

3. **No destructive actions without confirmation.** `rm -rf`, force-push, branch delete, drop table — always confirm first.

4. **Port 3002** for any test server you launch. Port 3001 is the user's.

5. **Commit style:** conventional commits (`feat(api): ...`, `fix(exports): ...`, `refactor(errors): ...`). Multi-line bodies with a `Why:` if helpful. Include the Claude co-author trailer:
   ```
   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
   ```

---

## Where specific documents live

### transcript-eval (`/Users/laurynas/Desktop/one last /transcript-eval/`)

- `docs/specs/2026-04-23-envato-export-design.md` — **Main design spec.** Complete 4-stage funnel overview. Reference for context / rejected alternatives / UX screens.
- `docs/specs/2026-04-23-envato-export-extension.md` — **YOUR spec.** Read this first.
- `docs/specs/2026-04-22-slack-alerts-design.md`, `docs/specs/2026-04-16-pipeline-split-design.md` — unrelated, earlier features. Skip.
- `docs/superpowers/plans/2026-04-23-envato-export-phase1.md` — Phase 1 backend plan (already implemented). Read if you want the backend contract rationale.
- `docs/superpowers/plans/2026-04-22-db-pool-structural-fix.md` — unrelated earlier plan, good reference for the codebase's curl-based verification pattern.
- `docs/handoff-extension-session.md` — this file.
- `server/routes/exports.js`, `server/services/{exports,ext-jwt,freepik,errors}.js`, `server/services/pexels.js` — Phase 1 code. **Read `server/services/ext-jwt.js` to understand the JWT format** your extension will receive.
- `server/schema-pg.sql` — canonical DDL. `exports` + `export_events` tables are there.

### adpunk.ssh (`/Users/laurynas/Documents/Adpunk.Ssh/`)

- `docs/superpowers/specs/2026-04-23-broll-candidate-pipeline.md` — adpunk.ssh's spec for stages 1-3. Read only if you need to understand what goes into `broll_searches.results_json`.
- `CLAUDE.md` — adpunk.ssh codebase overview.
- `proxy/*.py` — provider modules (Pexels, Storyblocks, Freepik). Envato scraper is the user's active work.

---

## First moves for your session

1. **Read the extension spec end-to-end** (`docs/specs/2026-04-23-envato-export-extension.md`). Don't skim — there are load-bearing details in every section.
2. **Ask the user:**
   - Option A (inside transcript-eval) or Option B (separate repo) for the extension codebase? (See "Where to put the extension" above.)
   - Do they want to start with Ext.1 (MV3 skeleton + JWT round-trip) or a different slice first?
   - Is there a design/visual direction for the popup UI, or build-to-spec?
3. **Read Phase 1's JWT module** (`server/services/ext-jwt.js` in the transcript-eval backend) so you know exactly what token shape you'll receive.
4. **Don't try to start the Phase 1 backend yourself.** It's already running in the user's other context or on Railway. If you need to test against it, ask the user to start `npm run dev:server` in the transcript-eval worktree or give you a staging URL.
5. **Invoke `superpowers:writing-plans`** once you've chosen the first phase to implement. The skill will produce a task-by-task plan you then execute via `superpowers:subagent-driven-development`.

---

## Active open questions across the three projects

These affect the extension but aren't yours to resolve unilaterally — confirm with the user when relevant:

1. **Chrome Extension ID.** Needs to be pinned in dev (key-based manifest) so the web app's `externally_connectable` whitelist matches. Pin before Ext.1 ships.
2. **`GET /api/ext-config` backend endpoint.** Not yet shipped. Needed before GA for min-version gate + kill-switch. Flag as a Phase 1.5 backend PR when you need it.
3. **Beta Envato subscription ownership.** Needed for Ext.2 (first real Envato traffic). ~$33/mo. Who pays / owns?
4. **Who writes `broll_searches.results_json`?** Open question from adpunk.ssh spec — either adpunk.ssh writes directly to Supabase, or transcript-eval writes after receiving HTTP response. Not your problem but affects when the manifest format stabilizes.
5. **Freepik URL TTL parsing.** Backend currently sets `expires_at = now + 15min` (conservative). Real TTL is 15-60 min encoded in the signed token. Skip parsing for MVP unless refetch cost becomes a concern.

---

## Concurrency with the other Claude session

The user has a second Claude Code session running in another terminal, working on the adpunk.ssh project. Things to know:

- That session may edit `broll_searches.results_json` schema assumptions. If you notice the manifest shape in the extension spec drifting from adpunk.ssh's output, flag it to the user — don't silently adapt.
- They may add per-item metadata fields. Extension should tolerate unknown fields (drop them, don't crash).
- No overlap in files — that session edits `/Users/laurynas/Documents/Adpunk.Ssh/**`, this session edits the extension codebase + possibly minor transcript-eval web app changes.
- Slack alerts fired by either system go to the same channel; both will be visible to the user.

If you need adpunk.ssh to produce something that isn't in the spec yet, tell the user; they'll coordinate with the other session.

---

## Summary

You're building the Chrome extension half of an already-architected system. The backend is live, the upstream scraper is being built in parallel, and the spec for your work is detailed. Your job is to turn that spec into working extension code, shipped in PR-sized chunks (Ext.1 → Ext.12), using the superpowers skill stack for plan + execute + review.

Start by reading `docs/specs/2026-04-23-envato-export-extension.md`.
