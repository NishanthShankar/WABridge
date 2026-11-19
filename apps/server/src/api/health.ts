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
  'private', // X-Private: true or "private": true on any request: nothing it sends is stored; message.status webhooks
  'poll-stealth', // poll.stealth: answers held in memory until acknowledged, never stored
  'poll-lifecycle', // poll ref, deleteAt, delete retries, poll.deleted / poll.delete_failed, lookup by scheduledMessageId
  'chat-lists', // GET/POST/PATCH/DELETE /api/lists, POST /api/lists/:id/chats, list.updated webhooks
  'api-docs', // GET /api/docs: this whole reference as markdown
  'group-info', // PATCH /api/groups/:id (name, description), PUT/DELETE /api/groups/:id/picture, pictureUrl on create
  'message-actions', // POST /api/messages/edit, /delete, /forward, /star
  'rich-messages', // location, contact cards, sticker and videoNote media types
  'group-membership', // join/preview by link, leave, revoke invite, join requests, joinApproval setting
  'profile', // GET/PATCH /api/profile, /picture, PATCH /api/profile/business, PUT /api/profile/business/cover
  'status-posts', // POST /api/status (text, image, video to a chosen audience), DELETE /api/status/:id
  'contact-tags', // /api/contact-tags (new name of /api/labels, which still works)
  'message-types', // event, groupInvite, product, reaction, voiceNote, gif, viewOnce, fileName, mimetype, mentions and quote on POST /api/messages
  'event-responses', // event.response webhooks, event.ref, GET /api/events
  'message-pin', // POST /api/messages/pin
  'chat-privacy', // limitSharing on PATCH /api/chats/:id, POST /api/chats/:id/phone-number
  'channels', // /api/channels: lookup, create, update, follow, post
  'catalog', // GET /api/profile/business/catalog
  'chat-actions', // PATCH /api/chats/:id (pin, archive, mute, read, disappearing), PUT /api/chats/disappearing-default
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
