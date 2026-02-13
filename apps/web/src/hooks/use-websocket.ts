import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/query-keys';
import { getApiKey } from '@/lib/auth';
import { WS_RECONNECT_BASE_MS, WS_RECONNECT_MAX_MS } from '@/lib/constants';
import type { WebSocketEvent } from '@/types/api';

export function useWebSocket() {
  const queryClient = useQueryClient();
  const reconnectAttempt = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let unmounted = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      if (unmounted) return;

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const apiKey = getApiKey();
      const qs = apiKey ? `?apiKey=${encodeURIComponent(apiKey)}` : '';
      const ws = new WebSocket(`${protocol}//${location.host}/ws${qs}`);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempt.current = 0;
      };

      ws.onmessage = (event) => {
        let msg: WebSocketEvent;
        try {
          msg = JSON.parse(event.data as string) as WebSocketEvent;
        } catch {
          return;
        }

        switch (msg.type) {
          case 'status':
            queryClient.setQueryData(queryKeys.connection.health, msg.data);
            break;
          case 'qr':
            queryClient.setQueryData(queryKeys.connection.qr, msg.data);
            break;
          case 'message:sent':
          case 'message:failed':
          case 'message:status':
            void queryClient.invalidateQueries({ queryKey: queryKeys.messages.all });
            void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
            break;
          case 'rate-limit:warning':
            queryClient.setQueryData(queryKeys.rateLimit.status, msg.data);
            toast.warning('Rate limit warning', {
              description: `${msg.data.remaining} messages remaining today`,
            });
            break;
          case 'rate-limit:reached':
            queryClient.setQueryData(queryKeys.rateLimit.status, msg.data);
            toast.error('Daily rate limit reached', {
              description: `Resets at ${msg.data.resetAt}`,
            });
            break;
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (unmounted) return;

        const delay = Math.min(
          WS_RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt.current),
          WS_RECONNECT_MAX_MS,
        );
        reconnectAttempt.current++;
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose will fire after onerror, which handles reconnection
      };
    }

    connect();

    return () => {
      unmounted = true;
      clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [queryClient]);
}
