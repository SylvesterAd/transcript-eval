// Pure manifest builder. Takes one or more per-variant API responses
// from GET /api/broll-searches/:pipelineId/manifest and turns them
// into the unified manifest the extension expects.
//
// Per spec § "Dedup strategy": key by (source, source_item_id);
// each source-item downloaded once regardless of how many variants
// reference it. Filename is `<NNN>_<source>_<id>.<ext>` where NNN is
// the order of first appearance across selected variants (zero-pad
// to 3 digits — matches the spec's example).
//
// The spec calls for one media folder shared across N XMLs in
// multi-variant exports. This function returns the deduped item list;
// XML emission is WebApp.2's job.
//
// API response shape (per variant):
//   {
//     pipeline_id, variant,
//     items: [
//       { seq, timeline_start_s, timeline_duration_s,
//         source, source_item_id, envato_item_url,
//         target_filename, resolution: {width,height},
//         frame_rate, est_size_bytes }
//     ],
//     totals: { count, est_size_bytes, by_source: {envato, pexels, freepik} }
//   }

const EXT_BY_SOURCE = {
  envato: 'mov',   // envato downloads can be .mov OR .mp4; we don't know
                   // until phase 2 of the extension flow — placeholder.
                   // The extension uses the actual content-disposition
                   // filename; this `target_filename` is only the prefix
                   // it sanitizes/conflict-resolves against.
  pexels: 'mp4',
  freepik: 'mp4',
}

function pad3(n) { return String(n).padStart(3, '0') }

function makeFilename(seq, source, sourceItemId) {
  const ext = EXT_BY_SOURCE[source] || 'mp4'
  // Sanitize source_item_id to ASCII-safe filename chars.
  const safe = String(sourceItemId).replace(/[^A-Za-z0-9_-]/g, '_')
  return `${pad3(seq)}_${source}_${safe}.${ext}`
}

/**
 * @param {{
 *   manifests: Array<{pipeline_id:string, variant:string, items:Array}>,
 *   options?: { force_redownload?: boolean }
 * }} input
 * @returns {{
 *   items: Array,
 *   totals: { count:number, est_size_bytes:number, by_source: {[k:string]:number} },
 *   variants: string[]
 * }}
 */
export function buildManifest({ manifests, options = {} }) {
  if (!Array.isArray(manifests) || manifests.length === 0) {
    return { items: [], totals: { count: 0, est_size_bytes: 0, by_source: {} }, variants: [] }
  }

  // Concatenate raw items across variants in input order. The extension
  // needs to know which variants each clip belongs to (so XML emitter
  // later can reference the same media file from multiple <sequence>s);
  // we attach `variants: ["A","C"]` per item.
  const seen = new Map()  // key `${source}|${id}` → item
  const variants = []

  for (const m of manifests) {
    if (!m || !Array.isArray(m.items)) continue
    if (m.variant && !variants.includes(m.variant)) variants.push(m.variant)

    for (const raw of m.items) {
      const source = raw.source
      const id = raw.source_item_id
      if (!source || !id) continue
      const key = `${source}|${id}`

      if (seen.has(key)) {
        const existing = seen.get(key)
        if (m.variant && !existing.variants.includes(m.variant)) existing.variants.push(m.variant)
        // Append the per-variant placement so the eventual XML can
        // reference the same media file from multiple sequences.
        existing.placements.push({
          variant: m.variant,
          timeline_start_s: raw.timeline_start_s,
          timeline_duration_s: raw.timeline_duration_s,
        })
        continue
      }

      const seq = seen.size + 1
      seen.set(key, {
        seq,
        source,
        source_item_id: id,
        envato_item_url: source === 'envato' ? (raw.envato_item_url || null) : null,
        target_filename: makeFilename(seq, source, id),
        resolution: raw.resolution || { width: 1920, height: 1080 },
        frame_rate: raw.frame_rate || 30,
        est_size_bytes: typeof raw.est_size_bytes === 'number' ? raw.est_size_bytes : 0,
        variants: m.variant ? [m.variant] : [],
        placements: [{
          variant: m.variant,
          timeline_start_s: raw.timeline_start_s,
          timeline_duration_s: raw.timeline_duration_s,
        }],
      })
    }
  }

  const items = [...seen.values()]

  let estTotal = 0
  const bySource = {}
  for (const it of items) {
    estTotal += it.est_size_bytes || 0
    bySource[it.source] = (bySource[it.source] || 0) + 1
  }

  return {
    items,
    totals: { count: items.length, est_size_bytes: estTotal, by_source: bySource },
    variants,
    options: { force_redownload: !!options.force_redownload },
  }
}

/**
 * Format a byte count as a human-readable string. Used by State C's
 * summary card and (later) State D's progress bar. Inlined here so
 * components don't pull in another formatting lib.
 */
export function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

/**
 * Estimate download time in minutes assuming a typical home connection
 * (75 Mbps effective throughput — close to the spec's "25-45 min for
 * 8.5 GB" range from State C's mockup). Returns a string like
 * "25-45 min". The range is the estimate ± 30%.
 */
export function estimateTimeRange(totalBytes) {
  if (!totalBytes || totalBytes <= 0) return '< 1 min'
  const bitsPerSec = 75 * 1024 * 1024  // 75 Mbps
  const seconds = (totalBytes * 8) / bitsPerSec
  const minutes = Math.ceil(seconds / 60)
  const low = Math.max(1, Math.round(minutes * 0.7))
  const high = Math.round(minutes * 1.3)
  if (low === high) return `${low} min`
  return `${low}-${high} min`
}
