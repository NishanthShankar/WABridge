import { createHmac, randomUUID } from 'node:crypto';
import type makeWASocket from '@whiskeysockets/baileys';
import {
  downloadContentFromMessage,
  getContentType,
  normalizeMessageContent,
  proto,
} from '@whiskeysockets/baileys';
import type {
  DownloadableMessage,
  MediaType,
  WAMessageKey,
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import { setupChatStateListener } from '../chats/chat-state.js';
import type { createDatabase } from '../db/client.js';
import { isPrivateDb, peekPrivateDb } from '../db/private.js';
import { handleEventResponse } from '../events/events.js';
import { getEvent } from '../events/events.js';
import { setupListListener } from '../lists/lists.js';
import { isNoStoreChat } from '../messages/no-store.js';
import { setupRecentMessages } from '../messages/recent-messages.js';
import { safeFetch } from '../net/safe-fetch.js';
import { claimVote } from '../polls/poll-accounts.js';
import { attachPollJobs } from '../polls/poll-jobs.js';
import {
  handlePollVote,
  locatePoll,
  sentByThisNumber,
} from '../polls/polls.js';
import { ackVote, holdVote } from '../polls/stealth-inbox.js';
import { setupPrivateDelivery } from '../scheduler/private-callbacks.js';
import { setAccountPhone } from './account.js';
import { recordInbound } from './chat-activity.js';
import { type GroupCache, createGroupCache } from './group-cache.js';
import { type IncomingClaim, claimIncoming } from './incoming.js';
import { isGroupJid, jidToPhone, ownJids } from './jid.js';
import { createWebhooksService } from './webhooks.service.js';

type Database = ReturnType<typeof createDatabase>;
type WASocket = ReturnType<typeof makeWASocket>;
type Webhook = ReturnType<
  ReturnType<typeof createWebhooksService>['list']
>[number];

/** Map from message key to Baileys MediaType */
const MEDIA_TYPE_MAP: Record<string, MediaType> = {
  imageMessage: 'image',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
};

const ProtocolType = proto.Message.ProtocolMessage.Type;

/**
 * Listen for incoming WhatsApp messages and fire matching webhooks.
 *
 * 1:1 messages go to webhooks registered for the sender's phone and to catch-all webhooks
 * (phone = null), as before. Group messages and the other events (message.reaction,
 * message.edited, message.deleted, group.participants, group.joined) only go to catch-all
 * webhooks that opted in with allEvents, so older receivers never see a payload they don't expect.
 *
 * Every inbound message also stamps chat_activity, which opens the 24 hour reply window
 * used by POST /api/reply.
 *
 * Re-attach on every reconnection via ConnectionManager.onConnected().
 */
export function setupWebhookListener(
  sock: WASocket,
  db: Database,
  logger: Logger,
): void {
  const groupCache = createGroupCache(sock, logger);
  const service = createWebhooksService(db);
  // Every webhook says which of our numbers it is about (accountPhone)
  setAccountPhone(db, sock.user?.id ? jidToPhone(sock.user.id) : null);
  // Presence and read receipts: presence.update and message.read webhooks, GET /api/chats/:id
  setupChatStateListener(sock, db, logger);
  // Poll deletes that are due (deleteAt) or being retried
  attachPollJobs(sock, db, logger);
  // Chat lists (labels) as they sync
  setupListListener(sock, db, logger);
  // Recent messages in memory, for POST /api/messages/forward and the edit/delete time checks
  // Not for chats the server keeps nothing of (messages/no-store.ts): not even in memory
  setupRecentMessages(sock, (jid) => isNoStoreChat(db, jid));
  // Delivery receipts of messages sent by private requests: message.status webhooks
  setupPrivateDelivery(sock, db, logger);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Only handle real-time messages, not history sync
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        await handleMessage(msg, sock, db, service, groupCache, logger);
      } catch (err) {
        logger.error(
          { err: (err as Error).message },
          'Webhook: failed to handle incoming message',
        );
      }
    }
  });

  sock.ev.on('group-participants.update', async (update) => {
    groupCache.invalidate(update.id);
    const hooks = service.getAllEvents();
    if (hooks.length === 0) return;

    const own = ownJids(sock);
    const participants = await Promise.all(
      update.participants.map(async (p) => ({
        jid: p.id,
        phone: p.phoneNumber
          ? jidToPhone(p.phoneNumber)
          : await resolvePhone(p.id, sock, logger),
        isMe:
          own.has(stripDevice(p.id)) ||
          (!!p.phoneNumber && own.has(stripDevice(p.phoneNumber))),
      })),
    );
    const group = await groupCache.get(update.id);
    const payload = {
      event: 'group.participants',
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      chatId: update.id,
      group: { id: update.id, name: group?.subject ?? null },
      action: update.action,
      author: update.authorPn
        ? jidToPhone(update.authorPn)
        : update.author
          ? await resolvePhone(update.author, sock, logger)
          : null,
      participants,
    };
    for (const hook of hooks) fireWebhook(hook, payload, logger);
  });

  // Fires when this account is added to a group (or creates one).
  sock.ev.on('groups.upsert', async (groups) => {
    const hooks = service.getAllEvents();
    if (hooks.length === 0) return;
    for (const g of groups) {
      groupCache.set(g);
      const payload = {
        event: 'group.joined',
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
        chatId: g.id,
        group: { id: g.id, name: g.subject ?? null },
        // Who added this account: the person who acted, not the group's creator.
        author: g.authorPn
          ? jidToPhone(g.authorPn)
          : await phoneOrNull(g.author, sock, logger),
        authorLid: g.author?.endsWith('@lid') ? g.author : null,
        owner: g.ownerPn
          ? jidToPhone(g.ownerPn)
          : await phoneOrNull(g.owner, sock, logger),
        participantCount: g.participants?.length ?? null,
      };
      for (const hook of hooks) fireWebhook(hook, payload, logger);
    }
  });

  sock.ev.on('groups.update', (updates) => {
    for (const u of updates) if (u.id) groupCache.invalidate(u.id);
  });
}

async function handleMessage(
  msg: proto.IWebMessageInfo,
  sock: WASocket,
  db: Database,
  service: ReturnType<typeof createWebhooksService>,
  groupCache: GroupCache,
  logger: Logger,
): Promise<void> {
  const key = msg.key as WAMessageKey | null | undefined;
  if (!key || key.fromMe) return; // skip outgoing

  const remoteJid = key.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast') return;

  const isGroup = isGroupJid(remoteJid);
  const authorJid = isGroup ? (key.participant ?? null) : remoteJid;
  if (!authorJid) return;

  // Resolve LID-addressed senders (e.g. "1234@lid") to a phone number.
  const senderLid = authorJid.endsWith('@lid') ? authorJid : null;
  const altJid = isGroup ? key.participantAlt : key.remoteJidAlt;
  const senderPhone = await resolvePhone(authorJid, sock, logger, altJid);

  const chat = {
    sock,
    db,
    logger,
    chatJid: remoteJid,
    altJid: (isGroup ? null : altJid) ?? null,
    isGroup,
  };
  const stub = { key, chatJid: remoteJid, isGroup, senderPhone, senderLid };

  if (!msg.message) {
    // Something WhatsApp delivered that could not be decrypted. The server has nothing to
    // deliver; an extension that has claimed the chat is told (webhooks/incoming.ts).
    if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {
      try {
        await (await claimIncoming(chat))?.unreadable?.(stub);
      } catch (err) {
        logger.error(
          { err: (err as Error).name },
          'Incoming: unreadable message could not be reported',
        );
      }
    }
    return;
  }

  const content = normalizeMessageContent(msg.message);
  if (!content) return;
  const contentType = getContentType(content);

  // Protocol messages that carry no new content (key distribution, history sync, ...)
  // are not "activity": skip them before stamping the reply window.
  const protocol = content.protocolMessage;
  const isEdit =
    protocol?.type === ProtocolType.MESSAGE_EDIT && !!protocol.editedMessage;
  const isRevoke = protocol?.type === ProtocolType.REVOKE;
  if (protocol && !isEdit && !isRevoke) return;
  // Key-distribution-only messages have no content type of their own.
  if (!contentType) return;

  recordInbound(
    db,
    remoteJid,
    !isGroup && senderPhone ? `${senderPhone}@s.whatsapp.net` : null,
  );

  // An extension may claim this chat's messages (webhooks/incoming.ts): then it handles
  // them and the server delivers nothing of them. Asked before anything looks at the
  // message. If the extension cannot tell, nothing is delivered.
  let claim: IncomingClaim | null;
  try {
    claim = await claimIncoming(chat);
  } catch (err) {
    // Only what kind of error: an error's text could quote what it choked on
    logger.error(
      { err: (err as Error).name },
      'Incoming: an extension could not decide on this chat: message not delivered',
    );
    return;
  }

  const anonymous = !!claim?.anonymous;
  const group = isGroup && !anonymous ? await groupCache.get(remoteJid) : null;
  // What every webhook about this message starts with. An anonymous claim leaves only who,
  // where and when: no profile name, no group name.
  const base = anonymous
    ? {
        timestamp: new Date().toISOString(),
        from: senderPhone,
        fromLid: senderLid,
        chatId: remoteJid,
        isGroup,
        ...(claim?.fields ?? {}),
      }
    : {
        timestamp: new Date().toISOString(),
        from: senderPhone,
        fromLid: senderLid,
        pushName: msg.pushName ?? null,
        chatId: remoteJid,
        isGroup,
        group: isGroup ? { id: remoteJid, name: group?.subject ?? null } : null,
        ...(claim?.fields ?? {}),
      };

  // ── Poll votes: decrypt, record, respond, then tell the same webhooks as messages ──
  if (content.pollUpdateMessage) {
    // The poll may live with another number of the same tenant (see locatePoll). Its votes,
    // webhooks and held stealth votes stay with the account that sent it.
    const pollId = content.pollUpdateMessage.pollCreationMessageKey?.id;
    const home = pollId ? locatePoll(db, sock, pollId) : null;
    if (!home) return;
    if (key.id && !claimVote(home.db, key.id)) return;
    const homeService =
      home.db === db ? service : createWebhooksService(home.db);
    const hooksFor = (): Webhook[] =>
      isGroup
        ? homeService.getAllEvents()
        : homeService.getByPhone(senderPhone);
    // Set when the number that took the vote is not the one that sent the poll, and when the
    // poll was sent by a private request (it and its votes are in memory only)
    const receivedBy = {
      ...(!sentByThisNumber(sock, home.poll) && sock.user?.id
        ? { receivedBy: jidToPhone(sock.user.id) }
        : {}),
      ...(isPrivateDb(home.db) ? { private: true } : {}),
    };
    // A stealth poll's vote lives only in memory until a webhook takes it (2xx) or the client
    // acknowledges it through /api/polls/pending.
    const deliverVote = (payload: Record<string | symbol, unknown>) => {
      if (!payload.stealth) {
        for (const hook of hooksFor()) fireWebhook(hook, payload, logger);
        return;
      }
      const held = holdVote(home.db, payload);
      const voteId = held.voteId as string;
      for (const hook of hooksFor())
        fireWebhook(hook, held, logger, undefined, () =>
          ackVote(home.db, voteId),
        );
    };
    const vote = await handlePollVote({
      sock,
      db: home.db,
      via: db,
      logger,
      update: content.pollUpdateMessage,
      voterJid: authorJid,
      voterAltJid: altJid,
      voterPhone: senderPhone,
      // A multi-choice vote that became final after the voter stopped tapping
      onSettled: (settled) =>
        deliverVote({
          ...base,
          timestamp: new Date().toISOString(),
          ...settled,
          ...receivedBy,
          messageId: key.id,
        }),
    });
    if (!vote) return;
    deliverVote({ ...base, ...vote, ...receivedBy, messageId: key.id });
    return;
  }

  // ── Answers to an event card (Going / Maybe / Can't go): same webhooks as messages ──
  if (content.encEventResponseMessage) {
    // An event card sent by a private request lives in the private database (memory)
    const eventId = content.encEventResponseMessage.eventCreationMessageKey?.id;
    const priv = peekPrivateDb(db);
    const inPrivate = !!priv && !!eventId && !!getEvent(priv, eventId);
    const answer = handleEventResponse({
      sock,
      db: inPrivate && priv ? priv : db,
      logger,
      enc: content.encEventResponseMessage,
      responderJid: authorJid,
      responderAltJid: altJid,
      responderPhone: senderPhone,
    });
    if (!answer) return;
    const hooks = isGroup
      ? service.getAllEvents()
      : service.getByPhone(senderPhone);
    for (const hook of hooks)
      fireWebhook(
        hook,
        {
          ...base,
          ...answer,
          ...(inPrivate ? { private: true } : {}),
          messageId: key.id,
        },
        logger,
      );
    return;
  }

  // ── Claimed by an extension: messages, edits and deletes are its to handle. Reactions
  //    stay with the server (below), and poll votes and event answers were handled above.
  //    From here on the server delivers nothing of this message, whatever goes wrong. ──
  if (claim && !content.reactionMessage) {
    try {
      await claim.take({
        ...stub,
        msg,
        content,
        contentType,
        isEdit,
        isRevoke,
        applyReplyActions: (actions) =>
          applyReplyActions(
            sock,
            msg,
            remoteJid,
            actions as ReplyActions,
            logger,
          ),
      });
    } catch (err) {
      // Only what kind of error: an error's text could quote what it choked on
      logger.error(
        { err: (err as Error).name },
        'Incoming: the extension that claimed this message could not handle it',
      );
    }
    return;
  }

  // ── Edits, deletes and reactions: opt-in events ────────────────────────────
  if (isEdit || isRevoke || content.reactionMessage) {
    const hooks = service.getAllEvents();
    if (hooks.length === 0) return;

    let payload: Record<string, unknown>;
    if (content.reactionMessage) {
      const target = content.reactionMessage.key;
      payload = {
        ...base,
        event: 'message.reaction',
        messageId: key.id,
        targetMessageId: target?.id ?? null,
        targetFromMe: !!target?.fromMe,
        emoji: content.reactionMessage.text || null, // null: reaction removed
      };
    } else if (isEdit) {
      const edited = normalizeMessageContent(protocol?.editedMessage);
      payload = {
        ...base,
        event: 'message.edited',
        messageId: protocol?.key?.id ?? null,
        text: extractText(edited),
      };
    } else {
      payload = {
        ...base,
        event: 'message.deleted',
        messageId: protocol?.key?.id ?? null,
      };
    }
    for (const hook of hooks) fireWebhook(hook, payload, logger);
    return;
  }

  // ── Regular messages ───────────────────────────────────────────────────────
  const hooks: Webhook[] = isGroup
    ? service.getAllEvents()
    : service.getByPhone(senderPhone);
  if (hooks.length === 0) return;

  const media = await downloadMedia(content, logger);
  const location = extractLocation(content);
  const contextInfo = getContextInfo(content, contentType);

  const own = ownJids(sock);
  const mentionedJids = contextInfo?.mentionedJid ?? [];
  const mentions = await Promise.all(
    mentionedJids.map(async (jid) => ({
      jid,
      phone: await resolvePhone(jid, sock, logger),
      isMe: own.has(stripDevice(jid)),
    })),
  );

  let quoted: Record<string, unknown> | null = null;
  if (contextInfo?.stanzaId) {
    const quotedParticipant = contextInfo.participant ?? null;
    const quotedFromMe =
      !!quotedParticipant && own.has(stripDevice(quotedParticipant));
    quoted = {
      messageId: contextInfo.stanzaId,
      fromMe: quotedFromMe,
      participant: quotedParticipant
        ? await resolvePhone(quotedParticipant, sock, logger)
        : null,
      text: extractText(normalizeMessageContent(contextInfo.quotedMessage)),
    };
  }

  const payload: Record<string, unknown> = {
    ...base,
    event: 'message.received',
    messageId: key.id,
    text: extractText(content) ?? media?.caption ?? null,
    hasMedia: !!media,
    rawType: contentType ?? Object.keys(msg.message)[0],
    isVoiceNote: !!content.audioMessage?.ptt,
    /** Sent as "view once". Whether its media reaches a linked device is up to WhatsApp. */
    viewOnce: isViewOnce(msg.message, content),
    mentions,
    botMentioned: mentions.some((m) => m.isMe),
    quoted,
  };
  if (media) payload.media = media;
  if (location) payload.location = location;

  // A receiver may answer with reply actions: see applyReplyActions.
  for (const hook of hooks) {
    fireWebhook(hook, payload, logger, (actions) =>
      applyReplyActions(sock, msg, remoteJid, actions, logger),
    );
  }
}

function isViewOnce(raw: proto.IMessage, content: proto.IMessage): boolean {
  return (
    !!raw.viewOnceMessage ||
    !!raw.viewOnceMessageV2 ||
    !!raw.viewOnceMessageV2Extension ||
    !!content.imageMessage?.viewOnce ||
    !!content.videoMessage?.viewOnce ||
    !!content.audioMessage?.viewOnce
  );
}

export function extractText(
  content: proto.IMessage | undefined,
): string | null {
  if (!content) return null;
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    null
  );
}

export function getContextInfo(
  content: proto.IMessage,
  contentType: keyof proto.IMessage | undefined,
): proto.IContextInfo | null {
  if (!contentType) return null;
  const inner = content[contentType] as
    | { contextInfo?: proto.IContextInfo | null }
    | undefined;
  if (inner && typeof inner === 'object' && 'contextInfo' in inner)
    return inner.contextInfo ?? null;
  return null;
}

async function downloadMedia(content: proto.IMessage, logger: Logger) {
  for (const [msgKey, mediaType] of Object.entries(MEDIA_TYPE_MAP)) {
    const mediaMsg = content[msgKey as keyof proto.IMessage] as
      | (DownloadableMessage & {
          mimetype?: string;
          fileName?: string;
          caption?: string;
        })
      | undefined;
    if (!mediaMsg) continue;

    const base = {
      type: mediaType,
      mimetype: mediaMsg.mimetype ?? `application/${mediaType}`,
      filename: mediaMsg.fileName ?? null,
      caption: mediaMsg.caption ?? null,
    };
    try {
      const stream = await downloadContentFromMessage(mediaMsg, mediaType);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return { ...base, data: Buffer.concat(chunks).toString('base64') };
    } catch (err) {
      logger.error(
        { err: (err as Error).message, mediaType },
        'Failed to download media',
      );
      return { ...base, data: '' };
    }
  }
  return null;
}

/**
 * Extract location details from a locationMessage or liveLocationMessage.
 * Returns null if the message doesn't carry a location.
 */
export function extractLocation(
  message: proto.IMessage,
): Record<string, unknown> | null {
  const loc = message.locationMessage;
  if (loc) {
    return {
      latitude: loc.degreesLatitude ?? null,
      longitude: loc.degreesLongitude ?? null,
      isLive: !!loc.isLive,
      name: loc.name ?? null,
      address: loc.address ?? null,
      url: loc.url ?? null,
      comment: loc.comment ?? null,
      accuracyInMeters: loc.accuracyInMeters ?? null,
      speedInMps: loc.speedInMps ?? null,
      degreesClockwiseFromMagneticNorth:
        loc.degreesClockwiseFromMagneticNorth ?? null,
      sequenceNumber: null,
    };
  }

  const live = message.liveLocationMessage;
  if (live) {
    return {
      latitude: live.degreesLatitude ?? null,
      longitude: live.degreesLongitude ?? null,
      isLive: true,
      name: null,
      address: null,
      url: null,
      comment: live.caption ?? null,
      accuracyInMeters: live.accuracyInMeters ?? null,
      speedInMps: live.speedInMps ?? null,
      degreesClockwiseFromMagneticNorth:
        live.degreesClockwiseFromMagneticNorth ?? null,
      sequenceNumber:
        live.sequenceNumber != null ? Number(live.sequenceNumber) : null,
    };
  }

  return null;
}

export function stripDevice(jid: string): string {
  const [user, server] = jid.split('@');
  return `${user.split(':')[0]}@${server}`;
}

/**
 * Turn a user JID into a phone number. Senders with phone privacy arrive as @lid; we try
 * the alternate JID Baileys attached, then the cached LID→PN map, then fall back to the
 * raw LID digits (still delivered, so catch-all webhooks fire).
 */
export async function resolvePhone(
  jid: string,
  sock: WASocket,
  logger: Logger,
  alt?: string | null,
): Promise<string> {
  if (!jid.endsWith('@lid')) return jidToPhone(jid);
  if (alt?.endsWith('@s.whatsapp.net')) return jidToPhone(alt);
  try {
    const pnJid = await sock.signalRepository.lidMapping.getPNForLID(jid);
    if (pnJid) return jidToPhone(pnJid);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'LID→PN resolution failed');
  }
  return jid.split('@')[0].split(':')[0];
}

/** Like resolvePhone, but null (not the LID's digits) when a LID can't be mapped to a phone. */
export async function phoneOrNull(
  jid: string | null | undefined,
  sock: WASocket,
  logger: Logger,
): Promise<string | null> {
  if (!jid) return null;
  const phone = await resolvePhone(jid, sock, logger);
  return jid.endsWith('@lid') && phone === jid.split('@')[0].split(':')[0]
    ? null
    : phone;
}

/** What a webhook receiver may ask for in the JSON body of its 2xx answer. */
export interface ReplyActions {
  /** true: delete the incoming message from this account's own devices ("delete for me"). */
  delete?: unknown;
  /** Seconds for the chat's disappearing-message timer: 0 (off), 86400, 604800 or 7776000. */
  ephemeral?: unknown;
  /** true: mark the incoming message as read (blue ticks). */
  read?: unknown;
}

/** The timers WhatsApp accepts for disappearing messages. */
const EPHEMERAL_SECONDS = [0, 86_400, 604_800, 7_776_000];

/**
 * Carry out what the receiver asked for. Message text is never logged.
 */
async function applyReplyActions(
  sock: WASocket,
  msg: proto.IWebMessageInfo,
  remoteJid: string,
  actions: ReplyActions,
  logger: Logger,
): Promise<void> {
  if (actions.read === true && msg.key) {
    try {
      await sock.readMessages([msg.key as WAMessageKey]);
    } catch (err) {
      logger.error(
        { err: (err as Error).message },
        'Could not mark the incoming message read',
      );
    }
  }
  if (actions.delete === true && msg.key?.id) {
    try {
      await sock.chatModify(
        {
          deleteForMe: {
            key: {
              remoteJid,
              id: msg.key.id,
              fromMe: false,
              participant: msg.key.participant,
            },
            timestamp: Number(
              msg.messageTimestamp ?? Math.floor(Date.now() / 1000),
            ),
            deleteMedia: true,
          },
        },
        remoteJid,
      );
    } catch (err) {
      logger.error(
        { err: (err as Error).message },
        'Could not delete the incoming message',
      );
    }
  }
  if (
    typeof actions.ephemeral === 'number' &&
    EPHEMERAL_SECONDS.includes(actions.ephemeral)
  ) {
    try {
      await sock.sendMessage(remoteJid, {
        disappearingMessagesInChat: actions.ephemeral,
      });
    } catch (err) {
      logger.error(
        { err: (err as Error).message },
        'Could not set the disappearing timer',
      );
    }
  }
}

/** Waits before each retry. A failed first attempt is retried twice, then dropped. */
const RETRY_DELAYS_MS = [2_000, 10_000];

/**
 * POST the payload, signed with X-Webhook-Signature (hex HMAC-SHA256 of the body) when the
 * webhook has a secret. Network errors, timeouts, 429 and 5xx are retried with the same body,
 * so receivers must de-duplicate on messageId / eventId. X-Webhook-Attempt counts from 1.
 */
export function fireWebhook(
  webhook: Pick<Webhook, 'url' | 'secret'> & { account?: string | null },
  payload: object,
  logger: Logger,
  onActions?: (actions: ReplyActions) => Promise<void>,
  /** Called once the receiver answers 2xx */
  onDelivered?: () => void,
): void {
  const { url, secret } = webhook;
  // Which of our numbers this is about: a tenant may run more than one
  const body = JSON.stringify(
    webhook.account ? { ...payload, accountPhone: webhook.account } : payload,
  );
  const signature = secret
    ? createHmac('sha256', secret).update(body).digest('hex')
    : null;

  const attempt = async (n: number): Promise<void> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Webhook-Attempt': String(n + 1),
    };
    if (signature) headers['X-Webhook-Signature'] = signature;

    let retry = false;
    try {
      // safeFetch: a webhook URL can't point the bridge at this machine or its network.
      const res = await safeFetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        logger.warn(
          { url, status: res.status, attempt: n + 1 },
          'Webhook responded with error',
        );
        retry = res.status === 429 || res.status >= 500;
      } else {
        onDelivered?.();
      }
      if (
        res.ok &&
        onActions &&
        (res.headers.get('content-type') ?? '').includes('application/json')
      ) {
        const actions = (await res
          .json()
          .catch(() => null)) as ReplyActions | null;
        if (actions && typeof actions === 'object') await onActions(actions);
      }
    } catch (err) {
      logger.error(
        { url, err: (err as Error).message, attempt: n + 1 },
        'Webhook delivery failed',
      );
      retry = true;
    }

    if (retry && n < RETRY_DELAYS_MS.length) {
      setTimeout(() => void attempt(n + 1), RETRY_DELAYS_MS[n]);
    }
  };

  void attempt(0);
}
