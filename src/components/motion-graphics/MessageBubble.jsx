export function MessageBubble({ message }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} my-2`}>
      <div
        className={`max-w-[70%] rounded-2xl px-4 py-3 ${
          isUser
            ? 'bg-amber-500 text-black'
            : 'bg-zinc-800 text-zinc-100 border border-zinc-700'
        }`}
      >
        <div className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</div>
        {!isUser && message.cost_cents > 0 && (
          <div className="mt-2 text-xs text-zinc-500">
            {message.model_used} · ${(message.cost_cents / 100).toFixed(2)}
          </div>
        )}
      </div>
    </div>
  );
}
