import type { WASocket } from '@whiskeysockets/baileys';
import type { AppContext } from '../context.js';
import { type PollInput, sendPoll } from '../polls/polls.js';
import {
  buildMessagePayload,
  parseSendOptions,
  reactionPayload,
  relayOptions,
} from './message-payload.js';
import { groupInvitePayload, productPayload } from './rich-content.js';

/** What a queued message keeps: the columns of scheduled_messages that decide what is sent. */
export interface StoredMessage {
  content: string;
  mediaUrl?: string | null;
  mediaType?: string | null;
  /** JSON of SendOptions */
  options?: string | null;
}

/**
 * Send a stored message to a chat and return its WhatsApp message id.
 * The kinds that need the socket or the database (poll, reaction, group invite, product) are
 * handled here; everything else is built by buildMessagePayload.
 */
export async function sendStored(
  sock: WASocket,
  db: AppContext['db'],
  jid: string,
  msg: StoredMessage,
): Promise<string | null> {
  // A queued poll is sent with sendPoll, so its votes can be read like any other poll.
  if (msg.mediaType === 'poll')
    return sendPoll(sock, db, jid, JSON.parse(msg.content) as PollInput);

  const options = parseSendOptions(msg.options);
  const payload =
    msg.mediaType === 'reaction'
      ? reactionPayload(jid, JSON.parse(msg.content))
      : msg.mediaType === 'groupInvite'
        ? await groupInvitePayload(sock, JSON.parse(msg.content))
        : msg.mediaType === 'product'
          ? productPayload(sock, JSON.parse(msg.content))
          : buildMessagePayload(
              msg.content,
              msg.mediaUrl,
              msg.mediaType,
              options,
            );
  const sent = await sock.sendMessage(jid, payload, relayOptions(jid, options));
  return sent?.key?.id ?? null;
}
