import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { EditorContext } from '../EditorView.jsx'
import TranscriptEditor from '../TranscriptEditor.jsx'

afterEach(cleanup)

// Minimal EditorContext value. Provides one audio track with three words.
// A cut covers "um" (0.5–0.8s). aiCutsSelected is the post-9a7f4a3 default
// (all annotation categories OFF) to reproduce the regression scenario.
function makeCtxValue({ cuts = [], aiCutsSelected = null } = {}) {
  return {
    state: {
      tracks: [
        {
          id: 'track-1',
          type: 'audio',
          offset: 0,
          duration: 5,
          transcriptWords: [
            { word: 'Hello', start: 0,   end: 0.5 },
            { word: 'um',    start: 0.5, end: 0.8 },  // inside cut
            { word: 'world', start: 0.8, end: 1.2 },
          ],
          waveformPeaks: null,
        },
      ],
      cuts,
      cutExclusions: [],
      annotations: { items: [] },
      // Simulate the post-applyConfigDefaults state (all annotation categories OFF,
      // silences ON) — this is what group 374 sees after the 9a7f4a3 regression.
      aiCutsSelected: aiCutsSelected ?? {
        silences: true,
        false_starts: false,
        filler_words: false,
        meta_commentary: false,
      },
      aiIdentifySelected: {
        repetition: false, lengthy: false, technical_unclear: false, irrelevance: false,
      },
      currentTime: 0,
      isPlaying: false,
      transcriptSelection: null,
      activeTab: 'roughcut',
    },
    dispatch: vi.fn(),
    playbackEngine: { current: null },
    cutDragRef: { current: false },
    flowRunState: null,
    handleStartAIRoughCut: vi.fn(),
    estimationLoading: false,
    isAdminUser: false,
    autoV2StrategyId: null,
    handleRunAutoV2: vi.fn(),
  }
}

describe('TranscriptEditor — rough-cut strike-through regression', () => {
  /**
   * REGRESSION GUARD — 9a7f4a3 + c9af6b6 interaction
   *
   * Before 9a7f4a3, applyConfigDefaults set annotation cut categories to true,
   * so annotation-derived cuts remained active and words showed as line-through.
   * After 9a7f4a3, defaults are false, which triggers the annotation cuts
   * useEffect to wipe cut-ai-ann-* from state, losing the strike-through.
   *
   * This test verifies the contract: when state.cuts has a cut that covers a word,
   * that word MUST render with line-through — regardless of aiCutsSelected state.
   * The fix (removing the redundant applyConfigDefaults call from the tab-entry
   * useEffect) preserves saved cuts and lets isItemCut do its job.
   */
  it('renders cut words with line-through when a cut covers the word — even with annotation categories OFF', () => {
    // Simulate state after applyConfigDefaults defaulted all annotation categories OFF
    // but state.cuts still has the properly-formed cuts loaded from DB.
    const cuts = [{ id: 'cut-ann-server-0', start: 0.5, end: 0.8, source: 'annotation' }]
    const ctxValue = makeCtxValue({ cuts })

    const { container } = render(
      <EditorContext.Provider value={ctxValue}>
        <TranscriptEditor />
      </EditorContext.Provider>
    )

    const allSpans = container.querySelectorAll('span')
    const umSpan = Array.from(allSpans).find(s => s.textContent.trim().startsWith('um'))

    expect(umSpan, 'could not find "um" span in rendered output').toBeDefined()
    expect(umSpan.className, '"um" span should have line-through class').toContain('line-through')
  })

  it('renders cut words from cut-ai-ann-* prefix with line-through', () => {
    // Frontend-generated annotation cuts (saved to DB as cut-ai-ann-*)
    const cuts = [{ id: 'cut-ai-ann-0', start: 0.5, end: 0.8, source: 'annotation' }]
    const ctxValue = makeCtxValue({ cuts })

    const { container } = render(
      <EditorContext.Provider value={ctxValue}>
        <TranscriptEditor />
      </EditorContext.Provider>
    )

    const allSpans = container.querySelectorAll('span')
    const umSpan = Array.from(allSpans).find(s => s.textContent.trim().startsWith('um'))

    expect(umSpan, 'could not find "um" span').toBeDefined()
    expect(umSpan.className, '"um" with cut-ai-ann-* cut must have line-through').toContain('line-through')
  })

  it('does NOT apply line-through to words outside the cut', () => {
    const cuts = [{ id: 'cut-1', start: 0.5, end: 0.8, source: 'transcript' }]
    const ctxValue = makeCtxValue({ cuts })

    const { container } = render(
      <EditorContext.Provider value={ctxValue}>
        <TranscriptEditor />
      </EditorContext.Provider>
    )

    const allSpans = container.querySelectorAll('span')
    const helloSpan = Array.from(allSpans).find(s => s.textContent.trim().startsWith('Hello'))
    const worldSpan = Array.from(allSpans).find(s => s.textContent.trim().startsWith('world'))

    if (helloSpan) expect(helloSpan.className).not.toContain('line-through')
    if (worldSpan) expect(worldSpan.className).not.toContain('line-through')
  })

  it('does NOT apply line-through when state.cuts is empty', () => {
    const ctxValue = makeCtxValue({ cuts: [] })

    const { container } = render(
      <EditorContext.Provider value={ctxValue}>
        <TranscriptEditor />
      </EditorContext.Provider>
    )

    const allSpans = container.querySelectorAll('span')
    Array.from(allSpans).forEach(s => {
      expect(s.className).not.toContain('line-through')
    })
  })

  it('does NOT apply line-through for zero-width split-point cuts (end === start)', () => {
    // splitAtPlayhead creates zero-width cuts; these should NOT mark words as cut
    const cuts = [{ id: 'cut-split', start: 0.65, end: 0.65, source: 'split' }]
    const ctxValue = makeCtxValue({ cuts })

    const { container } = render(
      <EditorContext.Provider value={ctxValue}>
        <TranscriptEditor />
      </EditorContext.Provider>
    )

    const allSpans = container.querySelectorAll('span')
    const umSpan = Array.from(allSpans).find(s => s.textContent.trim().startsWith('um'))
    // isItemCut requires c.end > c.start + 0.01 — zero-width cuts are excluded
    if (umSpan) expect(umSpan.className).not.toContain('line-through')
  })
})
