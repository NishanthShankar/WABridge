import { createHmac } from 'node:crypto';
import type makeWASocket from '@whiskeysockets/baileys';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import type { DownloadableMessage, MediaType, WAMessageKey, proto } from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import { createWebhooksService } from './webhooks.service.js';
import type { createDatabase } from '../db/client.js';

type Database = ReturnType<typeof createDatabase>;
type WASocket = ReturnType<typeof makeWASocket>;

/** Map from message key to Baileys MediaType */
const MEDIA_TYPE_MAP: Record<string, MediaType> = {
  imageMessage: 'image',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
};

/**
 * Listen for incoming WhatsApp messages and fire matching webhooks.
 *
 * When a message arrives from a phone number that has a registered webhook,
 * POSTs the message payload to the webhook URL — including downloaded media
 * as base64 for images, documents, audio, and video.
 *
 * Re-attach on every reconnection via ConnectionManager.onConnected().
 */
export function setupWebhookListener(
  sock: WASocket,
  db: Database,
  logger: Logger,
): void {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Only handle real-time messages, not history sync
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Skip outgoing messages and protocol messages
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid) continue;

      // Skip group messages for now
      if (remoteJid.endsWith('@g.us')) continue;

      // Resolve LID-addressed senders (e.g. "1234@lid") to a phone number.
      // Senders with phone-privacy enabled arrive as @lid; we fall back to:
      //   1. msg.key.remoteJidAlt (set by Baileys when both forms are known)
      //   2. signalRepository.lidMapping.getPNForLID (cached LID→PN map)
      //   3. The raw LID if neither resolves (still fires catch-all webhooks).
      const senderLid = remoteJid.endsWith('@lid') ? remoteJid : null;
      const senderPhone = await resolveSenderPhone(msg.key, sock, logger);

      const service = createWebhooksService(db);
      const matchingWebhooks = service.getByPhone(senderPhone);
      if (matchingWebhooks.length === 0) continue;

      // Extract text content
      const text =
        msg.message.conversation ??
        msg.message.extendedTextMessage?.text ??
        null;

      // Detect and download media
      let media: {
        type: string;
        mimetype: string;
        data: string; // base64
        filename: string | null;
        caption: string | null;
      } | null = null;

      for (const [msgKey, mediaType] of Object.entries(MEDIA_TYPE_MAP)) {
        const mediaMsg = msg.message[msgKey as keyof typeof msg.message] as
          | (DownloadableMessage & { mimetype?: string; fileName?: string; caption?: string })
          | undefined;

        if (!mediaMsg) continue;

        try {
          const stream = await downloadContentFromMessage(mediaMsg, mediaType);
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(chunk as Buffer);
          }
          const buffer = Buffer.concat(chunks);

          media = {
            type: mediaType,
            mimetype: mediaMsg.mimetype ?? `application/${mediaType}`,
            data: buffer.toString('base64'),
            filename: mediaMsg.fileName ?? null,
            caption: mediaMsg.caption ?? null,
          };
        } catch (err) {
          logger.error({ err: (err as Error).message, mediaType }, 'Failed to download media');
          media = {
            type: mediaType,
            mimetype: mediaMsg.mimetype ?? `application/${mediaType}`,
            data: '',
            filename: mediaMsg.fileName ?? null,
            caption: mediaMsg.caption ?? null,
          };
        }
        break; // only one media type per message
      }

      // Extract shared location (static pin or live location)
      const location = extractLocation(msg.message);

      // Build webhook payload
      const payload: Record<string, unknown> = {
        event: 'message.received',
        timestamp: new Date().toISOString(),
        from: senderPhone,
        fromLid: senderLid,
        messageId: msg.key.id,
        text: text ?? media?.caption ?? null,
        hasMedia: !!media,
        rawType: Object.keys(msg.message)[0],
      };

      if (media) {
        payload.media = media;
      }

      if (location) {
        payload.location = location;
      }

      // Fire all matching webhooks concurrently. A receiver may answer with reply actions
      // (delete this message from our side, set the chat's disappearing timer): see applyReplyActions.
      for (const webhook of matchingWebhooks) {
        fireWebhook(webhook.url, webhook.secret, payload, logger, (actions) =>
          applyReplyActions(sock, msg, remoteJid, actions, logger),
        );
      }
    }
  });
}

/**
 * Extract location details from a locationMessage or liveLocationMessage.
 * Returns null if the message doesn't carry a location.
 */
function extractLocation(message: proto.IMessage): Record<string, unknown> | null {
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
      degreesClockwiseFromMagneticNorth: loc.degreesClockwiseFromMagneticNorth ?? null,
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
      degreesClockwiseFromMagneticNorth: live.degreesClockwiseFromMagneticNorth ?? null,
      sequenceNumber: live.sequenceNumber != null ? Number(live.sequenceNumber) : null,
    };
  }

  return null;
}

async function resolveSenderPhone(
  key: WAMessageKey,
  sock: WASocket,
  logger: Logger,
): Promise<string> {
  const remoteJid = key.remoteJid ?? '';
  if (!remoteJid.endsWith('@lid')) {
    return remoteJid.replace('@s.whatsapp.net', '');
  }

  const alt = key.remoteJidAlt;
  if (alt?.endsWith('@s.whatsapp.net')) {
    return alt.replace('@s.whatsapp.net', '');
  }

  try {
    const pnJid = await sock.signalRepository.lidMapping.getPNForLID(remoteJid);
    if (pnJid) return pnJid.split(':')[0].split('@')[0];
  } catch (err) {
    logger.warn({ err: (err as Error).message, lid: remoteJid }, 'LID→PN resolution failed');
  }

  return remoteJid.replace('@lid', '');
}

/** What a webhook receiver may ask for in the JSON body of its 2xx answer. */
export interface ReplyActions {
  /** true: delete the incoming message from this account's own devices ("delete for me"). */
  delete?: unknown;
  /** Seconds for the chat's disappearing-message timer: 0 (off), 86400, 604800 or 7776000. */
  ephemeral?: unknown;
}

/** The timers WhatsApp accepts for disappearing messages. */
const EPHEMERAL_SECONDS = [0, 86_400, 604_800, 7_776_000];

/**
 * Carry out what the receiver asked for. Used by products that must not keep what people send
 * them: the message is removed from this account's chat history on every linked device as soon
 * as the receiver has read it. WhatsApp does not let an account delete someone else's message
 * for everyone, so the sender's own copy stays until the chat's disappearing timer removes it.
 * Message text is never logged.
 */
async function applyReplyActions(
  sock: WASocket,
  msg: proto.IWebMessageInfo,
  remoteJid: string,
  actions: ReplyActions,
  logger: Logger,
): Promise<void> {
  if (actions.delete === true && msg.key?.id) {
    try {
      await sock.chatModify(
        {
          deleteForMe: {
            key: { remoteJid, id: msg.key.id, fromMe: false },
            timestamp: Number(msg.messageTimestamp ?? Math.floor(Date.now() / 1000)),
            deleteMedia: true,
          },
        },
        remoteJid,
      );
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Could not delete the incoming message');
    }
  }
  if (typeof actions.ephemeral === 'number' && EPHEMERAL_SECONDS.includes(actions.ephemeral)) {
    try {
      await sock.sendMessage(remoteJid, { disappearingMessagesInChat: actions.ephemeral });
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Could not set the disappearing timer');
    }
  }
}

function fireWebhook(
  url: string,
  secret: string | null,
  payload: object,
  logger: Logger,
  onActions?: (actions: ReplyActions) => Promise<void>,
): void {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (secret) {
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    headers['X-Webhook-Signature'] = signature;
  }

  fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) })
    .then(async (res) => {
      if (!res.ok) {
        logger.warn({ url, status: res.status }, 'Webhook responded with error');
        return;
      }
      if (!onActions || !(res.headers.get('content-type') ?? '').includes('application/json')) return;
      const actions = (await res.json().catch(() => null)) as ReplyActions | null;
      if (actions && typeof actions === 'object') await onActions(actions);
    })
    .catch((err) => {
      logger.error({ url, err: (err as Error).message }, 'Webhook delivery failed');
    });
}
