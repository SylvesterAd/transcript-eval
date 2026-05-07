import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SessionList } from '../../components/motion-graphics/SessionList';
import { ChatThread } from '../../components/motion-graphics/ChatThread';
import { ChatInput } from '../../components/motion-graphics/ChatInput';
import { SpecSidebar } from '../../components/motion-graphics/SpecSidebar';
import {
  useGraphicsSession,
  useGraphicsSessionList,
} from '../../hooks/useGraphicsSession';

export default function MotionGraphicsView() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { sessions, refresh: refreshList, create } = useGraphicsSessionList();
  const activeId = sessionId ? Number(sessionId) : null;
  const { session, messages, renders, sendMessage } = useGraphicsSession(activeId);
  const [busy, setBusy] = useState(false);

  async function onNew() {
    const created = await create();
    navigate(`/admin/motion-graphics/${created.id}`);
  }

  async function onSelect(id) {
    navigate(`/admin/motion-graphics/${id}`);
  }

  async function onSend(text) {
    if (!activeId) {
      const created = await create();
      navigate(`/admin/motion-graphics/${created.id}`);
      return;
    }
    setBusy(true);
    try {
      await sendMessage(text);
      await refreshList();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-64px)]">
      <SessionList
        sessions={sessions}
        activeId={activeId}
        onSelect={onSelect}
        onNew={onNew}
      />
      <main className="flex flex-1 flex-col">
        {session ? (
          <>
            <ChatThread messages={messages} renders={renders} />
            <ChatInput disabled={busy} onSend={onSend} />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-zinc-500">
            Select or create a graphic.
          </div>
        )}
      </main>
      <SpecSidebar spec={session?.spec_json} />
    </div>
  );
}
