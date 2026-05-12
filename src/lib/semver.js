// Minimal x.y.z semver comparator. Mirrors extension/modules/config-fetch.js's
// compareSemver — kept duplicated rather than imported so the web app
// doesn't reach into the extension's source tree.
//
// Returns -1 / 0 / 1; throws on malformed input.
export function compareSemver(a, b) {
  const parse = s => {
    if (typeof s !== 'string') throw new Error(`compareSemver: expected string, got ${typeof s}`)
    const parts = s.split('.')
    if (parts.length !== 3) throw new Error(`compareSemver: expected x.y.z, got "${s}"`)
    return parts.map((p) => {
      const n = Number.parseInt(p, 10)
      if (!Number.isFinite(n) || String(n) !== p || n < 0) {
        throw new Error(`compareSemver: invalid segment "${p}" in "${s}"`)
      }
      return n
    })
  }
  const pa = parse(a), pb = parse(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1
    if (pa[i] > pb[i]) return 1
  }
  return 0
}

// Returns true when `current` is strictly older than `latest`. Returns
// false on missing / malformed input — callers should treat "unknown"
// as up-to-date so a parsing edge case never blocks a real install.
export function isOutdated(current, latest) {
  if (!current || !latest) return false
  try {
    return compareSemver(current, latest) < 0
  } catch {
    return false
  }
}
