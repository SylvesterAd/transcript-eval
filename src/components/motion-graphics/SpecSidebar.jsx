const FIELDS = [
  { key: 'template', label: 'Template' },
  { key: 'aspectRatio', label: 'Aspect ratio' },
  { key: 'duration', label: 'Duration (s)' },
  { key: 'mainText', label: 'Main text' },
  { key: 'subText', label: 'Sub text' },
  { key: 'tone', label: 'Tone' },
];

export function SpecSidebar({ spec = {} }) {
  return (
    <aside className="w-64 border-l border-zinc-800 bg-zinc-950 p-4 text-sm">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
        Current spec
      </h2>
      <dl className="space-y-2">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <dt className="text-xs text-zinc-500">{f.label}</dt>
            <dd className="text-zinc-200">
              {spec[f.key] != null ? String(spec[f.key]) : <span className="text-zinc-600">—</span>}
            </dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
