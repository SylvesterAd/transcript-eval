import { useState } from 'react';

export function ChatInput({ disabled, onSend }) {
  const [text, setText] = useState('');
  function submit(e) {
    e.preventDefault();
    if (!text.trim() || disabled) return;
    onSend(text.trim());
    setText('');
  }
  return (
    <form onSubmit={submit} className="border-t border-zinc-800 bg-zinc-950 px-6 py-4">
      <div className="flex items-end gap-3">
        <textarea
          className="flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-amber-500 focus:outline-none"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Describe the graphic, or answer the agent's question…"
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) submit(e);
          }}
        />
        <button
          type="submit"
          disabled={disabled || !text.trim()}
          className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-black hover:bg-amber-400 disabled:opacity-40"
        >
          {disabled ? 'Working…' : 'Send'}
        </button>
      </div>
    </form>
  );
}
