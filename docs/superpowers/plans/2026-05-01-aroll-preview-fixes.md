# A-Roll Preview Fixes (Sizing + HLS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix A-roll preview in B-roll editor (`/editor/:id/brolls/edit`) so it (a) renders at the same visible size as B-roll for matching aspect ratios and never overflows the preview area, and (b) loads efficiently via HLS adaptive bitrate at ~480p instead of always fetching the full-resolution Cloudflare MP4.

**Architecture:** Two minimally-coupled changes to the same component (`RoughCutPreview.jsx`). Fix 1 is a one-className tweak on the inner `<video>` so it follows the B-roll's `w-full h-full object-contain` sizing contract. Fix 2 introduces a tiny `useHlsSource` hook that swaps the MP4 download URL for an HLS manifest (with quality capping) when used inside the B-roll editor; the rough-cut editor keeps MP4 for frame-accurate seeking via an opt-in prop.

**Tech Stack:** React 18, `hls.js` ^1.6.15 (already in `package.json`), Vitest + happy-dom (existing test setup).

**Out of scope:** Changing the "render all videoTracks, only one visible" pattern in `RoughCutPreview.jsx:62`. The B-roll editor's per-track preload behavior stays. With `capLevelToPlayerSize: true` and explicit `maxAutoLevel` capping at 480p, hidden videos at 1×1 pick the lowest rendition automatically — that's the win we want from HLS.

---

## File Structure

- **Modify** `src/components/editor/RoughCutPreview.jsx` — sizing fix on `<video>` className; add `useHls` prop; replace direct `<video src=…>` with `useHlsSource` hook call.
- **Create** `src/hooks/useHlsSource.js` — tiny hook that imperatively attaches either an Hls.js instance (Chrome/Firefox), a native HLS src (Safari), or an MP4 src (fallback) to a video element. Caps quality at 480p.
- **Create** `src/hooks/__tests__/useHlsSource.test.jsx` — unit tests that mock `hls.js` and assert correct attachment / fallback / cleanup.
- **Modify** `src/components/editor/BRollPreview.jsx` — pass `useHls` to RoughCutPreview.

---

## Task 1: Bug Fix — A-Roll Video Sizing

**Files:**
- Modify: `src/components/editor/RoughCutPreview.jsx:118`

- [ ] **Step 1: Edit the video className**

In `src/components/editor/RoughCutPreview.jsx`, change line 118 from:

```jsx
className={visible ? 'max-w-full max-h-full object-contain' : 'absolute w-px h-px opacity-0 pointer-events-none overflow-hidden'}
```

to:

```jsx
className={visible ? 'w-full h-full object-contain' : 'absolute w-px h-px opacity-0 pointer-events-none overflow-hidden'}
```

Only the `visible` branch changes; the hidden branch stays identical.

- [ ] **Step 2: Run existing editor tests to verify no regression**

Run: `npx vitest run src/components/editor/__tests__/`
Expected: all existing tests PASS (no test currently asserts the className string, so this should be a clean run).

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/RoughCutPreview.jsx
git commit -m "fix(broll-editor): A-roll preview matches B-roll sizing contract

Switches PreviewVideo from max-w-full/max-h-full to w-full/h-full so
the <video> box always equals its container size and object-contain
handles aspect. Eliminates two related bugs in /editor/:id/brolls/edit:
A-roll appearing larger than B-roll on aspect-matched sources, and
A-roll overflowing into the PlaybackControls area."
```

---

## Task 2: Create `useHlsSource` Hook (with Tests)

**Files:**
- Create: `src/hooks/useHlsSource.js`
- Test: `src/hooks/__tests__/useHlsSource.test.jsx`

- [ ] **Step 1: Write the failing tests**

Create `src/hooks/__tests__/useHlsSource.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useHlsSource } from '../useHlsSource.js'

const hlsInstances = []
const HlsMock = vi.fn(function (config) {
  this.config = config
  this.loadSource = vi.fn()
  this.attachMedia = vi.fn()
  this.destroy = vi.fn()
  this.on = vi.fn()
  hlsInstances.push(this)
})
HlsMock.isSupported = vi.fn(() => true)
HlsMock.Events = { MANIFEST_PARSED: 'hlsManifestParsed' }

vi.mock('hls.js', () => ({ default: HlsMock }))

function makeVideoEl() {
  const el = document.createElement('video')
  el.canPlayType = vi.fn(() => '')
  return el
}

describe('useHlsSource', () => {
  beforeEach(() => {
    hlsInstances.length = 0
    HlsMock.mockClear()
    HlsMock.isSupported.mockReturnValue(true)
  })

  it('attaches Hls.js when hlsUrl provided and Hls.isSupported()', () => {
    const video = makeVideoEl()
    const ref = { current: video }
    renderHook(() => useHlsSource(ref, { hlsUrl: 'https://example/m.m3u8', mp4Url: null }))
    expect(hlsInstances).toHaveLength(1)
    expect(hlsInstances[0].loadSource).toHaveBeenCalledWith('https://example/m.m3u8')
    expect(hlsInstances[0].attachMedia).toHaveBeenCalledWith(video)
    expect(hlsInstances[0].config).toMatchObject({ capLevelToPlayerSize: true })
  })

  it('falls back to native src in Safari when Hls.isSupported() is false', () => {
    HlsMock.isSupported.mockReturnValue(false)
    const video = makeVideoEl()
    video.canPlayType = vi.fn(() => 'maybe')
    const ref = { current: video }
    renderHook(() => useHlsSource(ref, { hlsUrl: 'https://example/m.m3u8', mp4Url: 'https://example/m.mp4' }))
    expect(hlsInstances).toHaveLength(0)
    expect(video.src).toBe('https://example/m.m3u8')
  })

  it('falls back to mp4Url when hlsUrl is null', () => {
    const video = makeVideoEl()
    const ref = { current: video }
    renderHook(() => useHlsSource(ref, { hlsUrl: null, mp4Url: 'https://example/m.mp4' }))
    expect(hlsInstances).toHaveLength(0)
    expect(video.src).toBe('https://example/m.mp4')
  })

  it('destroys Hls instance on unmount', () => {
    const video = makeVideoEl()
    const ref = { current: video }
    const { unmount } = renderHook(() =>
      useHlsSource(ref, { hlsUrl: 'https://example/m.m3u8', mp4Url: null })
    )
    const instance = hlsInstances[0]
    unmount()
    expect(instance.destroy).toHaveBeenCalledTimes(1)
  })

  it('caps quality at ~480p via MANIFEST_PARSED handler', () => {
    const video = makeVideoEl()
    const ref = { current: video }
    renderHook(() => useHlsSource(ref, { hlsUrl: 'https://example/m.m3u8', mp4Url: null }))
    const instance = hlsInstances[0]
    const handler = instance.on.mock.calls.find(c => c[0] === 'hlsManifestParsed')?.[1]
    expect(handler).toBeTypeOf('function')
    instance.levels = [
      { height: 240 }, { height: 360 }, { height: 480 }, { height: 720 }, { height: 1080 },
    ]
    handler()
    // Indices 0,1,2 are ≤480p; cap should be 2.
    expect(instance.autoLevelCapping).toBe(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/hooks/__tests__/useHlsSource.test.jsx`
Expected: FAIL with "Cannot find module '../useHlsSource.js'"

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useHlsSource.js`:

```js
import { useEffect } from 'react'
import Hls from 'hls.js'

/**
 * Imperatively attaches a video source to a <video> element.
 * Order of preference:
 *   1. hlsUrl + Hls.js (Chrome/Firefox) — adaptive bitrate, capped at ~480p.
 *   2. hlsUrl + native HLS (Safari).
 *   3. mp4Url (fallback).
 *
 * @param {React.RefObject<HTMLVideoElement>} videoRef
 * @param {{ hlsUrl: string|null, mp4Url: string|null }} sources
 */
export function useHlsSource(videoRef, { hlsUrl, mp4Url }) {
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    if (hlsUrl && Hls.isSupported()) {
      const hls = new Hls({
        capLevelToPlayerSize: true,
        maxBufferLength: 10,
      })
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        const levels = hls.levels || []
        let cap = -1
        for (let i = 0; i < levels.length; i++) {
          if ((levels[i].height ?? 0) <= 480) cap = i
        }
        if (cap >= 0) hls.autoLevelCapping = cap
      })
      hls.loadSource(hlsUrl)
      hls.attachMedia(video)
      return () => hls.destroy()
    }

    if (hlsUrl && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsUrl
      return () => {
        video.removeAttribute('src')
        video.load()
      }
    }

    if (mp4Url) {
      video.src = mp4Url
      return () => {
        video.removeAttribute('src')
        video.load()
      }
    }
  }, [videoRef, hlsUrl, mp4Url])
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/hooks/__tests__/useHlsSource.test.jsx`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useHlsSource.js src/hooks/__tests__/useHlsSource.test.jsx
git commit -m "feat(hooks): useHlsSource — adaptive HLS playback w/ MP4 fallback

Tiny hook that attaches an Hls.js instance to a <video> element when
HLS is supported, falls back to native HLS in Safari, and finally to
plain MP4. Caps adaptive level at 480p via MANIFEST_PARSED to keep
preview bandwidth low. Used next to swap A-roll preview off MP4
downloads in the B-roll editor."
```

---

## Task 3: Wire `useHlsSource` into `PreviewVideo`, Add `useHls` Prop

**Files:**
- Modify: `src/components/editor/RoughCutPreview.jsx` (top-level component signature; `PreviewVideo` body)

- [ ] **Step 1: Add `useHls` prop to `RoughCutPreview` and pass it down**

In `src/components/editor/RoughCutPreview.jsx`, change the component signature on line 5 from:

```jsx
export default function RoughCutPreview() {
```

to:

```jsx
export default function RoughCutPreview({ useHls = false }) {
```

In the same file, change the `<PreviewVideo>` invocation on lines 63–68 from:

```jsx
{videoTracks.map(track => (
  <PreviewVideo
    key={track.id}
    track={track}
    videoRefs={videoRefs}
    visible={track.videoId === activeTrack.videoId}
  />
))}
```

to:

```jsx
{videoTracks.map(track => (
  <PreviewVideo
    key={track.id}
    track={track}
    videoRefs={videoRefs}
    visible={track.videoId === activeTrack.videoId}
    useHls={useHls}
  />
))}
```

- [ ] **Step 2: Replace `PreviewVideo` body to use the hook**

In `src/components/editor/RoughCutPreview.jsx`, replace the entire `PreviewVideo` function (currently lines 97–124) with:

```jsx
function PreviewVideo({ track, videoRefs, visible, useHls }) {
  const ref = useRef(null)

  useEffect(() => {
    if (ref.current) {
      videoRefs.current[track.videoId] = ref.current
    }
    return () => { delete videoRefs.current[track.videoId] }
  }, [track.videoId, videoRefs])

  // Rough-cut editor uses Cloudflare MP4 (frame-accurate seeking).
  // B-roll editor uses HLS (adaptive bitrate, ~480p cap) for efficiency.
  const cfMp4Url = track.cfStreamUid
    ? `https://videodelivery.net/${track.cfStreamUid}/downloads/default.mp4`
    : null
  const cfHlsUrl = track.cfStreamUid
    ? `https://videodelivery.net/${track.cfStreamUid}/manifest/video.m3u8`
    : null
  const directSrc = track.filePath?.startsWith('http')
    ? track.filePath
    : track.filePath
      ? `/uploads/videos/${track.filePath.split('/').pop()}`
      : null

  const hlsUrl = useHls ? cfHlsUrl : null
  const mp4Url = cfMp4Url || directSrc

  useHlsSource(ref, { hlsUrl, mp4Url })

  if (!hlsUrl && !mp4Url) return null

  return (
    <video
      ref={ref}
      className={visible ? 'w-full h-full object-contain' : 'absolute w-px h-px opacity-0 pointer-events-none overflow-hidden'}
      preload="auto"
      playsInline
      muted
    />
  )
}
```

Note the removed `src={src}` on the `<video>` — the hook sets src imperatively now.

- [ ] **Step 3: Add the hook import at top of `RoughCutPreview.jsx`**

In `src/components/editor/RoughCutPreview.jsx`, change line 1 from:

```jsx
import { useContext, useEffect, useRef, useMemo } from 'react'
```

(it should already include `useEffect` and `useRef`; verify), and add a new import line right below the existing imports (after `import { formatTime } from './useEditorState.js'`):

```jsx
import { useHlsSource } from '../../hooks/useHlsSource.js'
```

- [ ] **Step 4: Run editor tests to verify no regression**

Run: `npx vitest run src/components/editor/__tests__/`
Expected: all PASS.

- [ ] **Step 5: Run the full vitest `web` project to catch import/render regressions**

Run: `npx vitest run --project web`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/editor/RoughCutPreview.jsx
git commit -m "feat(broll-editor): opt-in HLS for A-roll preview via useHls prop

PreviewVideo now uses useHlsSource to attach either Hls.js (when
useHls=true), native HLS in Safari, or plain MP4. The rough-cut
editor still gets MP4 (frame-accurate seeking) by leaving useHls
defaulted to false. Wiring from BRollPreview comes in the next commit."
```

---

## Task 4: Enable HLS from `BRollPreview`

**Files:**
- Modify: `src/components/editor/BRollPreview.jsx:79`

- [ ] **Step 1: Pass `useHls={true}` to RoughCutPreview**

In `src/components/editor/BRollPreview.jsx`, change line 79 from:

```jsx
        <RoughCutPreview />
```

to:

```jsx
        <RoughCutPreview useHls />
```

- [ ] **Step 2: Run the relevant tests**

Run: `npx vitest run src/components/editor/__tests__/ src/hooks/__tests__/useHlsSource.test.jsx`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/BRollPreview.jsx
git commit -m "feat(broll-editor): switch A-roll preview to HLS adaptive bitrate

Passes useHls to RoughCutPreview from the B-roll editor only. With
the 480p cap in useHlsSource, a small preview window now fetches
~480p segments instead of the full Cloudflare default.mp4 (typically
720-1080p), saving roughly 3-5x bandwidth per active V1 track. The
rough-cut editor's preview is unaffected (still MP4, frame-accurate)."
```

---

## Task 5: Manual Browser Verification

**Files:** none modified.

- [ ] **Step 1: Build the frontend**

Run: `npm run build`
Expected: clean build, no type/lint errors.

- [ ] **Step 2: Verify in deployed Vercel preview (or local Vite dev — NOT `dev:server`)**

Open `/editor/:id/brolls/edit` for a project with multiple V1 tracks. Confirm:

1. **Sizing fix**: A-roll fits the preview area exactly like B-roll did. When playback transitions from A-roll → B-roll → A-roll, no size jump for matching aspect ratios. A-roll never overflows under PlaybackControls regardless of where you drag the horizontal splitter.

2. **HLS network behavior**: Open DevTools → Network → filter `videodelivery`. Expected:
   - `*/manifest/video.m3u8` requests instead of `*/downloads/default.mp4`.
   - Segment URLs ending `.ts` or `.m4s`.
   - Filter by Initiator and check the active V1 track's segment URLs reference a 480p-or-lower variant playlist (CF chunk URLs encode the rendition).

3. **Rough-cut editor unaffected**: Navigate to `/editor/:id/cut`. Confirm Network tab still shows `downloads/default.mp4` for V1 playback (frame-accurate seeking preserved).

4. **Safari sanity check**: If a Mac with Safari is available, confirm A-roll plays in B-roll editor (native HLS path, no Hls.js).

- [ ] **Step 3: Report results**

Comment in the PR / mark this task complete only if all four checks pass. If any fails, return to the relevant task and root-cause before continuing.

---

## Rollback Plan

Each task is its own commit. To revert:
- Sizing only: `git revert <Task 1 SHA>`.
- HLS only: `git revert <Task 4 SHA>`. (Task 2/3 leave the hook in place but inert with `useHls=false` default.)
- Everything: `git revert <Task 1..Task 4 SHAs>`.
