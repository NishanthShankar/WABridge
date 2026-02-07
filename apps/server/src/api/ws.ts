import type { Hono } from 'hono';
import { createNodeWebSocket } from '@hono/node-ws';
import type { WSContext } from 'hono/ws';
import type { ConnectionHealth } from '../bridge/types.js';

/** Function to get current health for sending to new WS clients */
type GetHealthFn = () => ConnectionHealth;

/**
 * Create a WebSocket handler for real-time QR and status push.
 *
 * Maintains a set of connected WebSocket clients.
 * New clients receive the current health state immediately on connect.
 * The broadcast function pushes messages to all connected clients.
 */
export function createWebSocketHandler(
  app: Hono,
  getHealth: GetHealthFn,
  apiKey?: string,
) {
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({
    app,
  });

  const clients = new Set<WSContext>();

  const wsHandler = upgradeWebSocket((c) => ({
    onOpen(_evt, ws) {
      // Authenticate if apiKey is configured
      if (apiKey) {
        const url = new URL(c.req.url);
        const clientKey = url.searchParams.get('apiKey');
        if (clientKey !== apiKey) {
          ws.close(4001, 'Invalid API key');
          return;
        }
      }
      clients.add(ws);
      // Send current health state immediately to new client
      ws.send(
        JSON.stringify({ type: 'status', data: getHealth() }),
      );
    },
    onClose(_evt, ws) {
      clients.delete(ws);
    },
  }));

  /**
   * Broadcast a message to all connected WebSocket clients.
   * Silently removes clients that fail to receive messages.
   */
  function broadcast(message: object): void {
    const data = JSON.stringify(message);
    for (const ws of clients) {
      try {
        ws.send(data);
      } catch {
        clients.delete(ws);
      }
    }
  }

  return { wsHandler, broadcast, injectWebSocket };
}
