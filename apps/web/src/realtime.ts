import type { Delta, WsMessage } from '@mdw/shared';
import { useStore } from './store.js';

/**
 * WebSocket client with exponential backoff + jitter. On every (re)connect the server's cursor is
 * compared with ours; if we are behind, or a delta arrives non-contiguously, we fetch a fresh
 * snapshot. Nothing relies on messages that happened while we were disconnected.
 */
export function startRealtime(): () => void {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const url = () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/ws`;

  const open = () => {
    if (stopped) return;
    useStore.getState().setWs('connecting');
    ws = new WebSocket(url());
    ws.onopen = () => {
      attempt = 0;
      useStore.getState().setWs('open');
      heartbeat = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), 45_000);
    };
    ws.onmessage = (m) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(String(m.data)) as WsMessage;
      } catch {
        return;
      }
      const st = useStore.getState();
      if (msg.type === 'hello') {
        if (msg.cursor !== st.data.cursor || !st.data.loaded) void st.resync();
      } else if (msg.type === 'delta') {
        if (st.receive(msg as Delta) === 'resync') void st.resync();
      }
    };
    ws.onclose = () => {
      if (heartbeat) clearInterval(heartbeat);
      useStore.getState().setWs('closed');
      if (stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** attempt++) * (0.7 + Math.random() * 0.6);
      timer = setTimeout(open, delay);
    };
    ws.onerror = () => ws?.close();
  };

  const onVisible = () => {
    if (document.visibilityState === 'visible' && useStore.getState().ws === 'closed') {
      if (timer) clearTimeout(timer);
      attempt = 0;
      open();
    }
  };
  document.addEventListener('visibilitychange', onVisible);
  const clock = setInterval(() => useStore.getState().tick(), 15_000);
  open();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    clearInterval(clock);
    document.removeEventListener('visibilitychange', onVisible);
    ws?.close();
  };
}
