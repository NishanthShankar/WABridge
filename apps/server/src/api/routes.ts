import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Queue } from 'bullmq';
import type { ServerPlugin } from '../plugin.js';
import { getContext } from '../context.js';
import { createHealthRouter } from './health.js';
import { renderStatusPage } from '../web/status-page.js';
import { createContactsRouter } from '../contacts/contacts.router.js';
import { createLabelsRouter } from '../labels/labels.router.js';
import { createTemplatesRouter } from '../templates/templates.router.js';
import { createSchedulingRouter } from '../scheduling/scheduling.router.js';
import { createGroupsRouter } from '../groups/groups.router.js';
import { createRateLimitRouter } from '../rate-limit/rate-limit.router.js';

/** Relative path from CWD (apps/server/) to the web build output */
const WEB_DIST = '../web/dist';

/**
 * Create the Hono application with all routes mounted.
 *
 * The plugin provides:
 * - apiMiddleware: sets AppContext on every /api/* request
 * - setupWebSocket: creates WS handler with the same Hono instance
 * - adminRoutes (optional): e.g., /admin/tenants in multi-tenant mode
 *
 * Route priority (first match wins):
 * 1. API routes (/api/*)
 * 2. WebSocket (/ws)
 * 3. Static assets (production: serves from apps/web/dist)
 * 4. SPA fallback (production: serves index.html for client-side routing)
 * 5. Status page (development fallback when web build doesn't exist)
 */
export function createApp(plugin: ServerPlugin, messageQueue: Queue) {
  const app = new Hono();

  // Security headers on all responses
  app.use('*', secureHeaders());

  // Create WebSocket handler with the SAME Hono app instance
  const { wsHandler, injectWebSocket } = plugin.setupWebSocket(app);

  // Check if web build exists (production mode)
  const webDistExists = existsSync(resolve(WEB_DIST, 'index.html'));

  // Development fallback: show status page when web app hasn't been built
  if (!webDistExists) {
    app.get('/', (c) => {
      return c.html(renderStatusPage());
    });
  }

  // Apply plugin middleware to all API routes (sets AppContext per request)
  app.use('/api/*', plugin.apiMiddleware);

  // Mount admin routes if plugin provides them (e.g., multi-tenant admin)
  if (plugin.adminRoutes) {
    const { router, basePath, middleware } = plugin.adminRoutes;
    if (middleware) {
      app.use(`${basePath}/*`, middleware);
    }
    app.route(basePath, router);
  }

  // Health API
  app.route('/api', createHealthRouter());

  // Labels API
  app.route('/api/labels', createLabelsRouter());

  // Messages API
  app.route('/api/messages', createSchedulingRouter(messageQueue));

  // Groups API
  app.route('/api/groups', createGroupsRouter());

  // Rate Limit API
  app.route('/api/rate-limit', createRateLimitRouter());

  // Contacts API (pass queue for birthday sync)
  app.route('/api/contacts', createContactsRouter(messageQueue));

  // Templates API
  app.route('/api/templates', createTemplatesRouter());

  // Test send endpoint (development only)
  app.post('/api/test-send', async (c) => {
    const { getSocket } = getContext(c);
    const { phone, message } = await c.req.json();
    if (!phone || !message) {
      return c.json({ error: 'phone and message required' }, 400);
    }
    const sock = getSocket();
    if (!sock) {
      return c.json({ error: 'WhatsApp not connected' }, 503);
    }
    try {
      const jid = phone.replace('+', '') + '@s.whatsapp.net';
      const result = await sock.sendMessage(jid, { text: message });
      return c.json({ sent: true, key: result?.key });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // WebSocket endpoint (before static files so /ws isn't caught by SPA fallback)
  app.get('/ws', wsHandler);

  // ─── Production static file serving ──────────────────────────────────────────
  if (webDistExists) {
    app.use('/assets/*', serveStatic({ root: WEB_DIST }));
    app.use('/*', serveStatic({ root: WEB_DIST }));
    app.get('*', serveStatic({ root: WEB_DIST, path: 'index.html' }));
  }

  return { app, injectWebSocket };
}
