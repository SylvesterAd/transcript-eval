import { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';
import { RenderViewer } from './RenderViewer';

export function ChatThread({ messages, renders }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages.length, renders.length]);

  return (
    <div ref={ref} className="flex-1 overflow-y-auto px-6 py-4">
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
      {renders.map((r) => (
        <RenderViewer key={r.id} render={r} />
      ))}
    </div>
  );
}
