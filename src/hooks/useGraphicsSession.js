import { useEffect, useState, useCallback } from 'react';
import { apiGet, apiPost } from './useApi.js';

export function useGraphicsSession(sessionId) {
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [renders, setRenders] = useState([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const data = await apiGet(`/graphics/sessions/${sessionId}`);
      setSession(data.session);
      setMessages(data.messages);
      setRenders(data.renders);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const sendMessage = useCallback(
    async (text) => {
      const r = await apiPost(`/graphics/sessions/${sessionId}/messages`, { message: text });
      await refresh();
      return r;
    },
    [sessionId, refresh]
  );

  return { session, messages, renders, loading, sendMessage, refresh };
}

export function useGraphicsSessionList() {
  const [sessions, setSessions] = useState([]);
  const refresh = useCallback(async () => {
    const data = await apiGet('/graphics/sessions');
    setSessions(data);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const create = useCallback(async () => {
    const created = await apiPost('/graphics/sessions', { title: 'New graphic' });
    await refresh();
    return created;
  }, [refresh]);
  return { sessions, refresh, create };
}
