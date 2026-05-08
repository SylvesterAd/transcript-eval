import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { EditorContext } from '../EditorView.jsx'
import TranscriptEditor from '../TranscriptEditor.jsx'

afterEach(cleanup)

// Minimal EditorContext value. Provides one audio track with three words.
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
            { word: 'um',    start: 0.5, end: 0.8 },
            { word: 'world', start: 0.8, end: 1.2 },
          ],
          waveformPeaks: null,
        },
      ],
      cuts,
      cutExclusions: [],
      annotations: { items: [] },
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

describe('TranscriptEditor — rough-cut cut visual', () => {
  /**
   * Strike-through is reserved for user-applied cuts (Backspace adds
   * source:'transcript'). Annotation-source cuts (auto-derived from rough-cut
   * suggestions) stay in state.cuts so the playback engine + b-roll pipeline
   * see them, but render only as the annotation's colored highlight — never
   * as strike-through. The user's flow is: open rough-cut → see clean text
   * with yellow/colored hints → manually backspace to apply cuts.
   */

  it('does NOT apply line-through to words in annotation-source cuts', () => {
    const cuts = [{ id: 'cut-ann-server-0', start: 0.5, end: 0.8, source: 'annotation' }]
    const ctxValue = makeCtxValue({ cuts })

    const { container } = render(
      <EditorContext.Provider value={ctxValue}>
        <TranscriptEditor />
      </EditorContext.Provider>
    )

    const umSpan = Array.from(container.querySelectorAll('span'))
      .find(s => s.textContent.trim().startsWith('um'))
    expect(umSpan, 'could not find "um" span').toBeDefined()
    expect(umSpan.className, 'annotation-cut word must NOT have line-through').not.toContain('line-through')
  })

  it('does NOT apply line-through for cut-ai-ann-* prefix annotation cuts either', () => {
    const cuts = [{ id: 'cut-ai-ann-0', start: 0.5, end: 0.8, source: 'annotation' }]
    const ctxValue = makeCtxValue({ cuts })

    const { container } = render(
      <EditorContext.Provider value={ctxValue}>
        <TranscriptEditor />
      </EditorContext.Provider>
    )

    const umSpan = Array.from(container.querySelectorAll('span'))
      .find(s => s.textContent.trim().startsWith('um'))
    expect(umSpan).toBeDefined()
    expect(umSpan.className).not.toContain('line-through')
  })

  it('DOES apply line-through to words in user-applied (transcript-source) cuts', () => {
    const cuts = [{ id: 'cut-1747000000', start: 0.5, end: 0.8, source: 'transcript' }]
    const ctxValue = makeCtxValue({ cuts })

    const { container } = render(
      <EditorContext.Provider value={ctxValue}>
        <TranscriptEditor />
      </EditorContext.Provider>
    )

    const umSpan = Array.from(container.querySelectorAll('span'))
      .find(s => s.textContent.trim().startsWith('um'))
    expect(umSpan, 'could not find "um" span').toBeDefined()
    expect(umSpan.className, 'manual-cut word must have line-through').toContain('line-through')
  })

  it('manual cut on top of an annotation cut wins — word strikes through', () => {
    const cuts = [
      { id: 'cut-ann-server-0', start: 0.5, end: 0.8, source: 'annotation' },
      { id: 'cut-1747000000',   start: 0.5, end: 0.8, source: 'transcript' },
    ]
    const ctxValue = makeCtxValue({ cuts })

    const { container } = render(
      <EditorContext.Provider value={ctxValue}>
        <TranscriptEditor />
      </EditorContext.Provider>
    )

    const umSpan = Array.from(container.querySelectorAll('span'))
      .find(s => s.textContent.trim().startsWith('um'))
    expect(umSpan).toBeDefined()
    expect(umSpan.className).toContain('line-through')
  })

  it('does NOT apply line-through to words outside any cut', () => {
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

    Array.from(container.querySelectorAll('span')).forEach(s => {
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

    const umSpan = Array.from(container.querySelectorAll('span'))
      .find(s => s.textContent.trim().startsWith('um'))
    if (umSpan) expect(umSpan.className).not.toContain('line-through')
  })
})
