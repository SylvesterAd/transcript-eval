# Hyperframes Skills (developer tooling)

The Hyperframes project ships [Skills](https://github.com/heygen-com/hyperframes/tree/main/skills) that register as Claude Code slash-commands. They are **optional developer tooling** — the production render pipeline (`server/services/graphics/`) does not depend on them.

## Install

```bash
npx --yes skills add heygen-com/hyperframes
```

Registers these slash-commands locally:

- `/hyperframes` — top-level domain expert
- `/hyperframes-cli` — CLI command reference
- `/hyperframes-media` — Kokoro TTS / Whisper / u2net background-removal helpers
- `/hyperframes-registry` — component registry helpers
- `/tailwind` — Tailwind utilities
- `/website-to-hyperframes` — convert a website screenshot to a Hyperframes scene
- `/remotion-to-hyperframes` — port Remotion compositions

## Why install

These give domain-expert assistance for hand-authoring HTML when iterating on few-shots, debugging codegen output, or building new motion-graphic templates by hand. They are **not** part of the render-worker prod path.

## Note on platform variance

The `skills` runtime (Vercel) may not install via the canonical command on every machine. If `npx --yes skills add ...` fails, the skills are still readable directly from the upstream repo at https://github.com/heygen-com/hyperframes/tree/main/skills — you can clone the repo and consult the skill markdown files manually when authoring few-shots or HTML by hand.
