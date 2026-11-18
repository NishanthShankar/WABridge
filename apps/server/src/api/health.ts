import { Hono } from 'hono';
import { getContext } from '../context.js';

/**
 * Create the health API router.
 * GET /api/health returns JSON health status.
 */
/** What this server can do. Clients check this before relying on a feature. */
export const FEATURES = [
  'webhook-reply-actions',
  'webhook-read-action',
  'webhook-all-events', // allEvents: group messages, reactions, edits, deletes, group membership
  'webhook-quoted-mentions', // quoted, mentions, botMentioned, isVoiceNote, chatId in message.received
  'webhook-retry',
  'reply-lane', // POST /api/reply
  'reply-media', // mediaUrl + mediaType on POST /api/reply
  'reply-poll', // poll on POST /api/reply
  'poll-votes', // poll.vote webhooks, poll modes, GET/DELETE /api/polls
  'reply-window', // replyWindow on /api/reply, GET /api/reply/window, GET /api/chats/:id
  'chat-presence', // presence.update + message.read webhooks, GET /api/chats/:id/presence
  'reply-dont-skip', // dontSkip / forcePoll on POST /api/reply
  'poll-stealth', // poll.stealth: answers held in memory until acknowledged, never stored
  'api-docs', // GET /api/docs: this whole reference as markdown
  'group-info', // PATCH /api/groups/:id (name, description), PUT/DELETE /api/groups/:id/picture, pictureUrl on create
  'group-participants', // GET /api/groups/:id/participants
  'group-create', // POST /api/groups, POST /api/groups/:id/participants, GET /api/groups/:id/invite
  'group-settings', // GET/PATCH /api/groups/:id/settings, settings on POST /api/groups
];

export function createHealthRouter() {
  const router = new Hono();

  router.get('/health', (c) => {
    const { getHealth } = getContext(c);
    // `features` lets a client check what this server can do before it relies on it.
    return c.json({ ...getHealth(), features: FEATURES });
  });

  return router;
}
