import { useCallback, useEffect, useRef, useState } from 'react';
import { ClientMessage, ServerMessage } from '../types';

const WORKER_URL = import.meta.env.VITE_WORKER_URL ?? '';
const WS_BASE = import.meta.env.DEV
  ? 'ws://localhost:8787'
  : WORKER_URL.replace('https://', 'wss://').replace('http://', 'ws://');

interface UseWebSocketOptions {
  roomId: string;
  onMessage: (msg: ServerMessage) => void;
  enabled?: boolean;
}

export function useWebSocket({ roomId, onMessage, enabled = true }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current || !enabled) return;
    const url = `${WS_BASE}/api/room/${roomId}/ws`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (mountedRef.current) setConnected(true);
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as ServerMessage;
        onMessageRef.current(msg);
      } catch {
        // ignore malformed
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      reconnectTimer.current = setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [roomId]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { send, connected };
}
