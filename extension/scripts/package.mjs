#!/usr/bin/env node
// extension/scripts/package.mjs — Ext.10 reproducible packager (skeleton)
//
// Produces extension/dist/extension-${version}.zip for Chrome Web Store
// submission. Runtime dep: fflate (already in package.json dependencies).
// Node stdlib only otherwise.
//
// INCLUDE-LIST, NOT EXCLUDE-LIST — this is load-bearing.
// A future developer adding debug files (.tmp, scratch.js, local-creds.json,
// .private-key.pem) to extension/ must NOT accidentally ship them. The
// include lists below name every runtime file / runtime directory explicitly.
// Fail-closed: unlisted files stay out of the zip.
//
// Usage:
//   node extension/scripts/package.mjs [--out <dir>] [--no-zip] [--verbose] [--help]
//
// CI (GitHub Actions) invokes this via `npm run ext:package`.
//
// Future Ext.10.5 mini-PR (DEFERRED): add --crx flag that reads
// EXTENSION_PRIVATE_KEY env var or extension/.private-key.pem and signs a
// CRX3 payload for self-hosted distribution. The Web Store accepts .zip
// directly, so .crx is only needed for side-loading.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'

// ---------- Include / exclude constants (frozen) ----------

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
// NOTE: extension/icons/ does not exist in the current tree, so it is
// NOT listed here. Add it to this list IF the extension gains toolbar
// icons later.
const DIR_INCLUDES = Object.freeze(['modules', 'fixtures'])

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

// ---------- CLI parsing ----------

function printUsage() {
  process.stdout.write(`Usage: node extension/scripts/package.mjs [flags]

Flags:
  --out <dir>    Output directory (default: extension/dist)
  --no-zip       Stage the dist tree only; skip the zip step (test harness)
  --verbose      Log each staged file path
  --help         Print this message and exit 0

The packager is deterministic — two runs on the same inputs produce a
byte-identical zip (epoch-zero mtime, level 9 compression).
`)
}

function parseArgs(argv) {
  const opts = { out: null, zip: true, verbose: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      opts.help = true
    } else if (a === '--no-zip') {
      opts.zip = false
    } else if (a === '--verbose' || a === '-v') {
      opts.verbose = true
    } else if (a === '--out') {
      const v = argv[++i]
      if (!v) throw new Error('--out requires a directory argument')
      opts.out = v
    } else if (a.startsWith('--out=')) {
      opts.out = a.slice('--out='.length)
    } else {
      throw new Error(`Unknown flag: ${a}`)
    }
  }
  return opts
}

// ---------- main (skeleton — stage + zip land in Tasks 2 + 3) ----------

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`[ext:package] ${err.message}\n\n`)
    printUsage()
    process.exit(2)
  }

  if (opts.help) {
    printUsage()
    return
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const extRoot = join(scriptDir, '..')
  const outDir = opts.out ? join(process.cwd(), opts.out) : join(extRoot, 'dist')

  const manifestPath = join(extRoot, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const version = manifest.version

  process.stdout.write(`[ext:package] Packaging transcript-eval extension v${version}\n`)
  process.stdout.write(`[ext:package]   out = ${outDir}\n`)
  process.stdout.write(`[ext:package]   zip = ${opts.zip}\n`)
  if (opts.verbose) {
    process.stdout.write(`[ext:package]   verbose = true\n`)
    process.stdout.write(`[ext:package]   extRoot = ${extRoot}\n`)
  }

  // Tasks 2 + 3 will implement stage + zip here.
}

// Use fileURLToPath to compare — paths with spaces are URL-encoded in
// import.meta.url (%20) but raw in process.argv[1], so a naive
// `file://${process.argv[1]}` comparison fails for this repo's path
// ("/Users/laurynas/Desktop/one last /transcript-eval").
const isDirectRun = (() => {
  try {
    return fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`[ext:package] ${err && err.stack ? err.stack : err}\n`)
    process.exit(1)
  })
}

export { parseArgs, printUsage, ROOT_INCLUDES, DIR_INCLUDES, DIR_EXCLUDES }
