import { useState } from 'react';
import { useIterationHistory } from '../../hooks/useIterationHistory.js';
import { IterationHistoryPanel } from './IterationHistoryPanel.jsx';

export function RenderViewer({ render }) {
  const [expanded, setExpanded] = useState(false);
  const iterCount = render.iteration_count ?? 1;
  const showToggle = render.status === 'complete' && iterCount > 1;
  const { iterations, loading, error, load } = useIterationHistory(render.id);

  const onToggle = () => {
    if (!expanded) load();
    setExpanded((v) => !v);
  };

  if (render.status === 'queued' || render.status === 'running') {
    return (
      <div className="my-3 rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-sm text-zinc-400">
        Render #{render.iteration} — {render.status}…
      </div>
    );
  }
  if (render.status === 'failed') {
    return (
      <div className="my-3 rounded-lg border border-red-700 bg-red-950 p-4 text-sm text-red-200">
        Render #{render.iteration} failed: {render.error_message}
      </div>
    );
  }
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900">
      <video src={render.output_url} controls className="block w-full max-w-2xl" />
      <div className="flex items-center justify-between px-4 py-2 text-xs text-zinc-400">
        <span>
          Render #{render.iteration} · {(render.duration_ms / 1000).toFixed(1)}s
          {render.final_score != null && render.final_score < 0.7 && (
            <span className="ml-2 rounded bg-amber-900 px-2 py-0.5 text-amber-200">
              low confidence
            </span>
          )}
        </span>
        <a href={render.output_url} download className="text-amber-400 hover:underline">
          Download MP4
        </a>
      </div>
      {showToggle && (
        <button
          type="button"
          onClick={onToggle}
          className="block w-full border-t border-zinc-800 bg-zinc-950 px-4 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-900"
        >
          {expanded ? 'Hide iterations' : `View ${iterCount} iterations`}
        </button>
      )}
      {showToggle && expanded && (
        <div className="border-t border-zinc-800 bg-zinc-950">
          <IterationHistoryPanel iterations={iterations} loading={loading} error={error} />
        </div>
      )}
    </div>
  );
}
