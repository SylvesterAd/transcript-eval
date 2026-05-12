import { describe, it, expect } from 'vitest'
import { buildSkeleton, listSkeletonInvariantFailures, FILL_MARKERS, SKELETON_INVARIANTS } from '../skeleton-builder.js'

describe('buildSkeleton', () => {
  it('produces a valid Hyperframes skeleton for a single-scene spec', () => {
    const spec = {
      template: 'lower-third',
      aspectRatio: '16:9',
      duration: 5,
      mainText: 'Anna',
      subText: 'Senior journalist',
      tone: 'neutral',
    }
    const html = buildSkeleton(spec)

    expect(html).toContain('data-composition-id="main"')
    expect(html).toContain('data-width="1920"')
    expect(html).toContain('data-height="1080"')
    expect(html).toContain('data-duration="5"')
    expect(html).toContain('class="scene clip" id="s1"')
    expect(html).toContain('window.__timelines["main"] = tl')
    expect(html).toContain('const tl = gsap.timeline({ paused: true })')

    // First scene starts visible (no visibility:hidden)
    expect(html).toMatch(/id="s1"[^>]*data-track-index="0">/)
    expect(html).not.toMatch(/id="s1"[^>]*style="visibility:hidden;"/)
  })

  it('handles 9:16 aspect ratio dimensions', () => {
    const html = buildSkeleton({
      template: 'lower-third', aspectRatio: '9:16',
      duration: 5, mainText: 'x', subText: 'y', tone: 'neutral',
    })
    expect(html).toContain('data-width="1080"')
    expect(html).toContain('data-height="1920"')
  })

  it('handles 1:1 square aspect ratio', () => {
    const html = buildSkeleton({
      template: 'lower-third', aspectRatio: '1:1',
      duration: 5, mainText: 'x', subText: 'y', tone: 'neutral',
    })
    expect(html).toContain('data-width="1080"')
    expect(html).toContain('data-height="1080"')
  })

  it('maps tone to --accent CSS custom property', () => {
    const dramaticHtml = buildSkeleton({
      template: 'lower-third', aspectRatio: '16:9',
      duration: 5, mainText: 'x', subText: 'y', tone: 'dramatic',
    })
    expect(dramaticHtml).toContain('--accent: #dc2626')

    const playfulHtml = buildSkeleton({
      template: 'lower-third', aspectRatio: '16:9',
      duration: 5, mainText: 'x', subText: 'y', tone: 'playful',
    })
    expect(playfulHtml).toContain('--accent: #10b981')
  })

  it('produces N scene divs with correct cumulative data-start values for multi-scene', () => {
    const spec = {
      aspectRatio: '16:9',
      tone: 'neutral',
      scenes: [
        { template: 'map', duration: 1, mainText: 'A', subText: '1' },
        { template: 'map', duration: 1.5, mainText: 'B', subText: '2' },
        { template: 'title-card', duration: 2.5, mainText: 'C', subText: '3' },
      ],
    }
    const html = buildSkeleton(spec)

    // Composition total
    expect(html).toContain('data-duration="5"')  // 1 + 1.5 + 2.5

    // Per-scene data-start values are cumulative
    expect(html).toMatch(/id="s1"[^>]*data-start="0"[^>]*data-duration="1"/)
    expect(html).toMatch(/id="s2"[^>]*data-start="1"[^>]*data-duration="1.5"/)
    expect(html).toMatch(/id="s3"[^>]*data-start="2.5"[^>]*data-duration="2.5"/)

    // Non-first scenes start hidden
    expect(html).toMatch(/id="s2"[^>]*style="visibility:hidden;"/)
    expect(html).toMatch(/id="s3"[^>]*style="visibility:hidden;"/)
  })

  it('emits one CLAUDE_FILL_SCENE_N marker per scene + STYLES + TWEENS markers', () => {
    const spec = {
      aspectRatio: '16:9',
      tone: 'neutral',
      scenes: [
        { template: 'map', duration: 1, mainText: 'A', subText: 'a' },
        { template: 'map', duration: 1, mainText: 'B', subText: 'b' },
      ],
    }
    const html = buildSkeleton(spec)
    expect(html).toContain(FILL_MARKERS.STYLES)
    expect(html).toContain(FILL_MARKERS.TWEENS)
    expect(html).toContain(FILL_MARKERS.scene(1))
    expect(html).toContain(FILL_MARKERS.scene(2))
    expect(html).not.toContain(FILL_MARKERS.scene(3))
  })

  it('falls back to 16:9 + neutral accent for unknown aspectRatio / tone values', () => {
    const html = buildSkeleton({
      template: 'lower-third', aspectRatio: 'banana',
      duration: 5, mainText: 'x', subText: 'y', tone: 'spicy',
    })
    expect(html).toContain('data-width="1920"')
    expect(html).toContain('--accent: #9ca3af')
  })

  it('output ALWAYS satisfies every SKELETON_INVARIANT before fill', () => {
    const html = buildSkeleton({
      aspectRatio: '16:9',
      tone: 'neutral',
      scenes: [
        { template: 'map', duration: 1, mainText: 'A', subText: 'a' },
        { template: 'title-card', duration: 2, mainText: 'B', subText: 'b' },
      ],
    })
    for (const invariant of SKELETON_INVARIANTS) {
      expect(html).toMatch(invariant)
    }
  })
})

describe('listSkeletonInvariantFailures', () => {
  it('returns an empty list when all invariants hold', () => {
    const html = buildSkeleton({
      template: 'lower-third', aspectRatio: '16:9',
      duration: 5, mainText: 'x', subText: 'y', tone: 'neutral',
    })
    // Simulate a successful fill: replace markers with realistic content
    const filled = html
      .replace(FILL_MARKERS.STYLES, '.lt-bar { color: white; }')
      .replace(FILL_MARKERS.scene(1), '<div class="lt-bar">Anna</div>')
      .replace(FILL_MARKERS.TWEENS, 'tl.to("#lt-bar", { autoAlpha: 1 }, 0.2);')
    expect(listSkeletonInvariantFailures(filled)).toEqual([])
  })

  it('reports the missing-timeline-registration failure', () => {
    const broken = '<!doctype html><div data-composition-id="main"></div><script>const tl = gsap.timeline({ paused: true });</script>'
    const failures = listSkeletonInvariantFailures(broken)
    expect(failures.some((f) => /__timelines/.test(f))).toBe(true)
  })

  it('reports unfilled CLAUDE_FILL markers as a failure', () => {
    const html = buildSkeleton({
      template: 'lower-third', aspectRatio: '16:9',
      duration: 5, mainText: 'x', subText: 'y', tone: 'neutral',
    })
    // Don't replace the markers — they remain
    expect(listSkeletonInvariantFailures(html)).toContain('CLAUDE_FILL markers remain unfilled')
  })

  it('reports missing composition root', () => {
    const broken = '<!doctype html><div>x</div><script>const tl = gsap.timeline({ paused: true }); window.__timelines["main"] = tl;</script>'
    const failures = listSkeletonInvariantFailures(broken)
    expect(failures.some((f) => /data-composition-id/.test(f))).toBe(true)
  })
})
