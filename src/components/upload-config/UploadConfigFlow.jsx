// src/components/upload-config/UploadConfigFlow.jsx
import { useReducer, useState } from 'react'
import { apiPut } from '../../hooks/useApi.js'
import Stepper from './Stepper.jsx'
import StepLibraries from './steps/StepLibraries.jsx'
import StepAudience from './steps/StepAudience.jsx'
import StepReferences from './steps/StepReferences.jsx'
import StepRoughCut from './steps/StepRoughCut.jsx'
import StepPath from './steps/StepPath.jsx'
import StepDone from './steps/StepDone.jsx'

// Full unified journey — header always shows upload + transcribe framing.
const UNIFIED_STEPS = [
  { id: 'upload',     label: 'Upload' },
  { id: 'libraries',  label: 'Libraries' },
  { id: 'audience',   label: 'Audience' },
  { id: 'references', label: 'Refs' },
  { id: 'roughcut',   label: 'Rough Cut' },
  { id: 'path',       label: 'Path' },
  { id: 'transcribe', label: 'Transcribe' },
]
// Config flow drives steps 1–4 of the unified list.
const CONFIG_STEPS = UNIFIED_STEPS.slice(1, 6)
const UNIFIED_OFFSET = 1

const DEFAULT_STATE = {
  libraries: [],
  freepikOptIn: true,
  audience: {
    age: ['millennial', 'gen_z'],
    sex: ['any'],
    ethnicity: ['any'],
    language: 'English',
    region: '',
    notes: '',
  },
  pathId: 'strategy-only',
  autoRoughCut: false,
}

function reducer(state, action) {
  switch (action.type) {
    case 'hydrate':      return { ...state, ...action.payload }
    case 'setLibraries': return { ...state, libraries: action.payload }
    case 'setFreepikOptIn': return { ...state, freepikOptIn: action.payload }
    case 'setAudience':  return { ...state, audience: action.payload }
    case 'setPathId':    return { ...state, pathId: action.payload }
    case 'setAutoRoughCut': return { ...state, autoRoughCut: action.payload }
    default: return state
  }
}

export default function UploadConfigFlow({ groupId, initialState, onBack, onComplete }) {
  const [current, setCurrent] = useReducerStep(0)
  const [submitted, setSubmitted] = useReducerStep(false)
  // Lazy initializer seeds from initialState once on mount. `key={groupId}`
  // in the parent forces a fresh mount per group, so we don't need a
  // hydrate effect that would re-fire on every parent re-render and
  // overwrite in-progress edits.
  const [state, dispatch] = useReducer(reducer, { ...DEFAULT_STATE, ...(initialState || {}) })
  // Tracks whether StepReferences has ≥2 refs AND a favorite. Defaults to
  // the value derivable from the (uninitialized) list — false — so the
  // gate is closed until StepReferences signals otherwise.
  const [referencesValid, setReferencesValid] = useState(false)
  const [roughCutValid, setRoughCutValid] = useState(true)
  const [pathValid, setPathValid] = useState(true)
  // Latest rough-cut token estimate, lifted up so the footer's Run CTA can
  // show "~N tokens". Null until StepRoughCut polls successfully.
  const [roughCutEstimate, setRoughCutEstimate] = useState(null)

  // Persist on step-forward. No-op without a valid groupId so navigation
  // never gets blocked by a doomed PUT (e.g. when the URL has no ?group=).
  // `overrides` lets callers pass values that haven't flushed through
  // setState yet (e.g. the rough-cut footer buttons set autoRoughCut and
  // immediately advance — without an override the PUT would read the
  // stale render-time closure).
  async function persistCurrent(overrides = {}) {
    if (!Number.isFinite(groupId)) return
    const stepId = CONFIG_STEPS[current].id
    const body = {}
    if (stepId === 'libraries') {
      body.libraries = state.libraries
      body.freepik_opt_in = state.freepikOptIn
    } else if (stepId === 'audience') {
      body.audience = state.audience
    } else if (stepId === 'path') {
      body.path_id = state.pathId
    } else if (stepId === 'roughcut') {
      body.auto_rough_cut = overrides.autoRoughCut ?? state.autoRoughCut
    }
    // references has no batched persistence — it hits its own API per-add
    if (Object.keys(body).length) {
      await apiPut(`/videos/groups/${groupId}`, body)
    }
  }

  const next = async (overrides) => {
    try { await persistCurrent(overrides) } catch {}
    if (current < CONFIG_STEPS.length - 1) setCurrent(current + 1)
    else setSubmitted(true)
  }
  const back = async () => {
    if (submitted) { setSubmitted(false); return }
    try { await persistCurrent() } catch {}
    if (current > 0) setCurrent(current - 1)
    else onBack?.()
  }

  const isLast = current === CONFIG_STEPS.length - 1
  const currentStepId = CONFIG_STEPS[current].id
  const continueDisabled =
    (currentStepId === 'references' && !referencesValid) ||
    (currentStepId === 'roughcut'   && !roughCutValid) ||
    (currentStepId === 'path'       && !pathValid)

  const setState = {
    libraries: v => dispatch({ type: 'setLibraries', payload: v }),
    freepikOptIn: v => dispatch({ type: 'setFreepikOptIn', payload: v }),
    audience: v => dispatch({ type: 'setAudience', payload: v }),
    pathId: v => dispatch({ type: 'setPathId', payload: v }),
    autoRoughCut: v => dispatch({ type: 'setAutoRoughCut', payload: v }),
  }

  let body
  if (submitted) body = <StepDone state={state} onEdit={() => setSubmitted(false)} onComplete={() => onComplete(groupId)} />
  else if (current === 0) body = <StepLibraries state={state} setState={setState} />
  else if (current === 1) body = <StepAudience state={state} setState={setState} />
  else if (current === 2) body = <StepReferences groupId={groupId} onValidityChange={setReferencesValid} />
  else if (current === 3) body = <StepRoughCut groupId={groupId} state={state} setState={setState} onValidityChange={setRoughCutValid} onEstimate={setRoughCutEstimate} />
  else if (current === 4) body = <StepPath state={state} setState={setState} groupId={groupId} onValidityChange={setPathValid} />

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-md p-6">
      <div className="w-full max-w-[1120px] max-h-[calc(100vh-48px)] bg-surface-container-low/95 backdrop-blur-2xl rounded-2xl overflow-hidden flex flex-col ring-1 ring-inset ring-white/4 shadow-[0_0_80px_rgba(0,0,0,0.8)]">
        {/* Header */}
        <div className="px-8 py-5 shrink-0 ring-[0.5px] ring-inset ring-white/4 flex items-center justify-between gap-6">
          <Stepper
            steps={UNIFIED_STEPS}
            current={submitted ? UNIFIED_OFFSET + CONFIG_STEPS.length : UNIFIED_OFFSET + current}
            onJump={async i => {
              if (i === 0) { onBack?.(); return }
              if (i >= UNIFIED_OFFSET && i < UNIFIED_OFFSET + CONFIG_STEPS.length) {
                try { await persistCurrent() } catch {}
                setSubmitted(false)
                setCurrent(i - UNIFIED_OFFSET)
              }
            }}
          />
        </div>

        {/* Body */}
        <div className="px-10 py-8 overflow-y-auto flex-1">
          {body}
        </div>

        {/* Footer */}
        {!submitted && (
          <div className="px-8 py-5 bg-surface-container-low/90 backdrop-blur-sm ring-[0.5px] ring-inset ring-white/4 flex items-center justify-between gap-5 shrink-0">
            <button
              onClick={back}
              className="text-on-surface-variant font-bold uppercase tracking-widest text-xs hover:text-on-surface transition-colors px-4 py-2"
            >
              {current === 0 ? 'Back to Upload' : 'Back'}
            </button>
            <div className="flex items-center gap-6">
              <div className="flex flex-col items-end">
                <span className={`text-[10px] font-extrabold uppercase tracking-[0.2em] font-['Inter'] ${isLast ? 'text-lime' : 'text-on-surface-variant'}`}>
                  {isLast ? 'Ready For Calibration' : `Step ${UNIFIED_OFFSET + current + 1} of ${UNIFIED_STEPS.length}`}
                </span>
                <span className="text-[11px] text-muted mt-0.5 font-['Inter']">
                  {isLast ? 'Est. analysis · 2m 45s' : `Next: ${CONFIG_STEPS[current + 1]?.label || ''}`}
                </span>
              </div>
              {currentStepId === 'roughcut' ? (
                <div className="flex items-center gap-2.5">
                  <button
                    onClick={async () => { setState.autoRoughCut(false); await next({ autoRoughCut: false }) }}
                    className="text-on-surface-variant font-bold uppercase tracking-widest text-xs hover:text-on-surface transition-colors px-5 py-3"
                  >
                    No, thanks
                  </button>
                  <button
                    onClick={async () => { setState.autoRoughCut(true); await next({ autoRoughCut: true }) }}
                    disabled={!roughCutValid}
                    title={!roughCutValid ? 'Not enough tokens for AI Rough Cut' : undefined}
                    className="bg-gradient-to-br from-lime to-primary-dim text-on-primary-container font-extrabold text-xs uppercase tracking-[0.15em] px-7 py-4 rounded-md shadow-[0_0_32px_rgba(206,252,0,0.25)] hover:shadow-[0_0_48px_rgba(206,252,0,0.45)] active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none disabled:active:scale-100 inline-flex items-center gap-2"
                  >
                    <span className="material-symbols-outlined text-base">auto_fix_high</span>
                    <span>Run Rough Cut{roughCutEstimate?.tokenCost ? ` · ~${roughCutEstimate.tokenCost.toLocaleString()} tokens` : ''}</span>
                    <span className="material-symbols-outlined text-base">arrow_forward</span>
                  </button>
                </div>
              ) : (
                <button
                  onClick={next}
                  disabled={continueDisabled}
                  title={
                    continueDisabled && currentStepId === 'references' ? 'Add at least 2 reference videos and pick a favorite' :
                    continueDisabled && currentStepId === 'path'       ? 'Full Auto requires ≥1 reference video and enough tokens for the chain' :
                    undefined
                  }
                  className="bg-gradient-to-br from-lime to-primary-dim text-on-primary-container font-extrabold text-xs uppercase tracking-[0.15em] px-8 py-4 rounded-md shadow-[0_0_32px_rgba(206,252,0,0.25)] hover:shadow-[0_0_48px_rgba(206,252,0,0.45)] active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none disabled:active:scale-100"
                >
                  {isLast ? 'Review & Continue' : 'Continue'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Tiny useState wrapper that lets reducers be named descriptively without ceremony.
function useReducerStep(init) {
  const [v, set] = useReducer((_, next) => next, init)
  return [v, set]
}
