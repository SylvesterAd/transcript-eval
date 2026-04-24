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
import { dirname, join, relative, resolve } from 'node:path'
import { readFile, readdir, mkdir, rm, copyFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { zipSync } from 'fflate'

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

// ---------- Stage helpers ----------

function isExcluded(relPath) {
  const p = relPath.split('\\').join('/')
  return DIR_EXCLUDES.some((rx) => rx.test(p))
}

async function walkFiles(root) {
  // Returns absolute file paths under root (recursive), filtering out
  // directory-level exclusions (e.g. __tests__) early to avoid traversing
  // unnecessary subtrees.
  const out = []
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const ent of entries) {
      const abs = join(dir, ent.name)
      const rel = relative(root, abs).split('\\').join('/')
      if (isExcluded(rel)) continue
      if (ent.isDirectory()) {
        await walk(abs)
      } else if (ent.isFile()) {
        out.push(abs)
      }
    }
  }
  await walk(root)
  return out
}

async function stageDist({ extRoot, outDir, verbose }) {
  // Wipe + recreate out dir.
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  let stagedCount = 0
  let bytesTotal = 0

  // Root file includes (must all exist).
  for (const name of ROOT_INCLUDES) {
    const src = join(extRoot, name)
    const dest = join(outDir, name)
    try {
      const s = await stat(src)
      if (!s.isFile()) {
        throw new Error(`ROOT_INCLUDES entry is not a file: ${name}`)
      }
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw new Error(`Missing required root file: ${name} (at ${src})`)
      }
      throw err
    }
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(src, dest)
    const size = (await stat(dest)).size
    stagedCount++
    bytesTotal += size
    if (verbose) {
      process.stdout.write(`[ext:package]   + ${name} (${size}B)\n`)
    }
  }

  // Directory includes — recursive, filtered.
  for (const dirName of DIR_INCLUDES) {
    const dirAbs = join(extRoot, dirName)
    let files
    try {
      files = await walkFiles(dirAbs)
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw new Error(`Missing required directory: ${dirName} (at ${dirAbs})`)
      }
      throw err
    }
    for (const absSrc of files) {
      const relFromExt = relative(extRoot, absSrc).split('\\').join('/')
      const dest = join(outDir, relFromExt)
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(absSrc, dest)
      const size = (await stat(dest)).size
      stagedCount++
      bytesTotal += size
      if (verbose) {
        process.stdout.write(`[ext:package]   + ${relFromExt} (${size}B)\n`)
      }
    }
  }

  return { stagedCount, bytesTotal }
}

// ---------- Zip ----------

async function zipDist({ outDir, version }) {
  // Walk outDir recursively, build fflate input map {posixPath: Uint8Array}.
  // Sorted by key for a deterministic zip central directory.
  const files = {}
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const ent of entries) {
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(abs)
      } else if (ent.isFile()) {
        // Skip any previously-generated zip in outDir to avoid self-inclusion.
        if (ent.name === `extension-${version}.zip`) continue
        const rel = relative(outDir, abs).split('\\').join('/')
        files[rel] = new Uint8Array(await readFile(abs))
      }
    }
  }
  await walk(outDir)

  // Deterministic ordering: sort keys.
  const sortedKeys = Object.keys(files).sort()
  const sortedFiles = {}
  for (const k of sortedKeys) sortedFiles[k] = files[k]

  // Deterministic output: level 9 (max compression), ZIP-epoch mtime.
  // Fixed timestamp at the ZIP format epoch (1980-01-01 UTC) — fflate
  // rejects dates outside 1980-2099, so plain 0 / new Date(0) do not work.
  // A stable "last modified" field means running the packager twice on the
  // same inputs produces byte-identical zips. The Web Store fingerprints
  // uploads; drift would defeat reproducible-build debugging.
  const ZIP_EPOCH = Date.UTC(1980, 0, 1)
  const zipBytes = zipSync(sortedFiles, { level: 9, mtime: ZIP_EPOCH })

  const zipPath = join(outDir, `extension-${version}.zip`)
  await writeFile(zipPath, zipBytes)

  const sha = createHash('sha256').update(zipBytes).digest('hex')
  return { zipPath, bytes: zipBytes.length, sha256: sha }
}

// ---------- main ----------

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
  // `resolve` honors absolute paths passed via --out while still
  // anchoring relative paths to cwd. Plain `join(cwd, opts.out)` would
  // double-prepend cwd when opts.out is already absolute.
  const outDir = opts.out ? resolve(process.cwd(), opts.out) : join(extRoot, 'dist')

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

  const { stagedCount, bytesTotal } = await stageDist({ extRoot, outDir, verbose: opts.verbose })
  process.stdout.write(
    `[ext:package] Staged ${stagedCount} files (${bytesTotal} bytes) -> ${outDir}\n`
  )

  if (opts.zip) {
    const { zipPath, bytes, sha256 } = await zipDist({ outDir, version })
    const displayPath = relative(process.cwd(), zipPath) || zipPath
    process.stdout.write(
      `[ext:package] Wrote ${displayPath} (${bytes} bytes, sha256=${sha256})\n`
    )
  }
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

export {
  parseArgs,
  printUsage,
  stageDist,
  zipDist,
  ROOT_INCLUDES,
  DIR_INCLUDES,
  DIR_EXCLUDES,
}
