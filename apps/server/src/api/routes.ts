import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Queue } from 'bullmq';
import type { ServerPlugin } from '../plugin.js';
import type { Extension } from '../extensions.js';
import { getContext } from '../context.js';
import { createHealthRouter } from './health.js';
import { renderStatusPage } from '../web/status-page.js';
import { createContactsRouter } from '../contacts/contacts.router.js';
import { createLabelsRouter } from '../labels/labels.router.js';
import { createTemplatesRouter } from '../templates/templates.router.js';
import { createSchedulingRouter } from '../scheduling/scheduling.router.js';
import { createGroupsRouter } from '../groups/groups.router.js';
import { createRateLimitRouter } from '../rate-limit/rate-limit.router.js';
import { createWebhooksRouter } from '../webhooks/webhooks.router.js';
import { createChatsRouter } from '../chats/chats.router.js';
import { createPollsRouter } from '../polls/polls.router.js';
import { createListsRouter } from '../lists/lists.router.js';
import { createDocsRouter } from './docs.js';
import { createReplyRouter } from '../reply/reply.router.js';
import { createMessageActionsRouter } from '../messages/message-actions.router.js';
import { createProfileRouter } from '../profile/profile.router.js';
import { createStatusRouter } from '../status/status.router.js';

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
/**
 * true when origin is in the allowed list: an exact origin, or a "https://*.example.com"
 * pattern matching one subdomain level of example.com.
 */
export function corsAllows(allowed: string[], origin: string): boolean {
  return allowed.some((entry) => {
    const wild = entry.match(/^(https?):\/\/\*\.(.+)$/i);
    if (!wild) return entry.toLowerCase() === origin.toLowerCase();
    const [, scheme, domain] = wild;
    const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${scheme}://[a-z0-9-]+\\.${escaped}$`, 'i').test(origin);
  });
}

export function createApp(
  plugin: ServerPlugin,
  messageQueue: Queue,
  extensions: Extension[] = [],
  healthOrigins: string[] = [],
) {
  const app = new Hono();

  // Security headers on all responses
  app.use('*', secureHeaders());

  // CORS for public health endpoint — must register BEFORE the API auth
  // middleware so preflight OPTIONS (which browsers send without x-api-key)
  // is handled before auth rejects the request.
  app.use(
    '/api/health',
    cors({
      origin: (origin) => (corsAllows(healthOrigins, origin) ? origin : null),
      allowHeaders: ['x-api-key', 'content-type'],
    }),
  );

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

  // Mount public routes BEFORE the /api/* auth middleware so they remain
  // unauthenticated. Plugins use this for token-in-URL endpoints (e.g. pairing).
  if (plugin.publicRoutes) {
    app.route(plugin.publicRoutes.basePath, plugin.publicRoutes.router);
  }

  // Further plugin route groups, each behind its own auth middleware
  for (const { router, basePath, middleware } of plugin.extraRoutes ?? []) {
    if (middleware) {
      app.use(basePath, middleware);
      app.use(`${basePath}/*`, middleware);
    }
    // The router type is generic over its own variables; the app only needs to mount it.
    app.route(basePath, router as Hono);
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

  // Contact tags: the bridge's own tags on contacts (not WhatsApp's chat labels: those are
  // /api/lists). /api/labels is the old name, kept working and marked deprecated.
  app.route('/api/contact-tags', createLabelsRouter());
  app.use('/api/labels/*', async (c, next) => {
    await next();
    c.header('Deprecation', 'true');
    c.header('Link', '</api/contact-tags>; rel="successor-version"');
  });
  app.use('/api/labels', async (c, next) => {
    await next();
    c.header('Deprecation', 'true');
    c.header('Link', '</api/contact-tags>; rel="successor-version"');
  });
  app.route('/api/labels', createLabelsRouter());

  // Messages API: edit, delete and forward sent messages, then scheduling
  app.route('/api/messages', createMessageActionsRouter());
  app.route('/api/messages', createSchedulingRouter(messageQueue));

  // Groups API
  app.route('/api/groups', createGroupsRouter());

  // Rate Limit API
  app.route('/api/rate-limit', createRateLimitRouter());

  // Contacts API (pass queue for birthday sync)
  app.route('/api/contacts', createContactsRouter(messageQueue));

  // Templates API
  app.route('/api/templates', createTemplatesRouter());

  // Webhooks API
  app.route('/api/webhooks', createWebhooksRouter());

  // Reply API: uncapped answers inside the 24 hour window after a chat wrote
  app.route('/api/reply', createReplyRouter(messageQueue));
  app.route('/api/polls', createPollsRouter(messageQueue));
  app.route('/api/lists', createListsRouter());
  app.route('/api/chats', createChatsRouter());
  app.route('/api/profile', createProfileRouter());
  app.route('/api/status', createStatusRouter());

  // The whole API reference as markdown (with extension docs), for agents
  app.route('/api/docs', createDocsRouter(extensions));

  // Extension routes (behind the same API key auth as the rest of /api)
  for (const ext of extensions) {
    for (const { basePath, router } of ext.routes ?? []) app.route(`/api/${basePath}`, router);
  }

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
