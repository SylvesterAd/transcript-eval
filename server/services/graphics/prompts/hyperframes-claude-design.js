// Upstream Hyperframes authoring guide, vendored verbatim so our HTML-generation
// prompt stays in lockstep with HeyGen's published rules (contract, banned APIs,
// self-review checklist, animation patterns, media rules).
//
//   Repo:    https://github.com/heygen-com/hyperframes
//   File:    docs/guides/claude-design-hyperframes.md
//   SHA:     9322ff9c74e20c447ef3d1c522f9d7fcbe76629b
//   Fetched: 2026-05-12
//   License: Apache-2.0
//
// To refresh: re-fetch raw content at a new pinned SHA, replace the .md
// sibling file, bump SHA + Fetched comment above. Do NOT edit the .md file
// in-place — it must remain a verbatim copy so diffs against upstream are
// meaningful.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const HYPERFRAMES_CLAUDE_DESIGN_GUIDE = readFileSync(
  join(__dirname, 'hyperframes-claude-design.md'),
  'utf-8',
)

export const HYPERFRAMES_GUIDE_SHA = '9322ff9c74e20c447ef3d1c522f9d7fcbe76629b'
