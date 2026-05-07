// Bucket a video's pixel dimensions into one of three aspect-ratio classes
// the b-roll search proxy understands (`landscape` | `square` | `portrait`).
//
// Used to populate the `orientation` field on `/broll/search` requests so
// adpunk.ssh's Pexels/Freepik adapters can hard-filter mismatched footage
// and the SigLIP/Qwen rerank can apply its 0.7× orientation penalty
// (adpunk.ssh/proxy/broll.py:381).
//
// Audio media has no pixel ratio — fall back to landscape, which matches
// the proxy's pre-existing default and keeps stock results unchanged for
// audio-only A-roll. Same fallback when width/height are missing (e.g.
// client probe failed and ffprobe hasn't run yet).
//
// Distance is measured in log-space against canonical targets so a video
// that's a few pixels off from 16:9 (1922×1080) lands in `landscape`
// instead of being penalized by linear-distance asymmetry around 1.0.

export function bucketAspect({ width, height, mediaType }) {
  if (mediaType === 'audio' || !width || !height) return 'landscape'
  const r = width / height
  const targets = { landscape: 16 / 9, square: 1, portrait: 9 / 16 }
  return Object.entries(targets)
    .map(([k, t]) => [k, Math.abs(Math.log(r) - Math.log(t))])
    .sort((a, b) => a[1] - b[1])[0][0]
}
