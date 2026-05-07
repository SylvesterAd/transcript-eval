export function SessionList({ sessions, activeId, onSelect, onNew }) {
  return (
    <aside className="flex w-72 flex-col border-r border-zinc-800 bg-zinc-950">
      <button
        onClick={onNew}
        className="m-3 rounded bg-amber-500 px-3 py-2 text-sm font-semibold text-black hover:bg-amber-400"
      >
        + New graphic
      </button>
      <ul className="flex-1 overflow-y-auto">
        {sessions.map((s) => (
          <li key={s.id}>
            <button
              onClick={() => onSelect(s.id)}
              className={`block w-full px-4 py-3 text-left text-sm hover:bg-zinc-900 ${
                activeId === s.id ? 'bg-zinc-900 text-amber-400' : 'text-zinc-300'
              }`}
            >
              <div className="font-medium truncate">{s.title || 'Untitled'}</div>
              <div className="mt-1 text-xs text-zinc-500 uppercase tracking-wider">
                {s.status}
              </div>
            </button>
          </li>
        ))}
        {sessions.length === 0 && (
          <li className="px-4 py-6 text-sm text-zinc-500">No graphics yet.</li>
        )}
      </ul>
    </aside>
  );
}
