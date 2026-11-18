import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  WAMessage,
} from '@whiskeysockets/baileys';
import { z } from 'zod';
import { assertPublicUrl } from '../net/safe-fetch.js';
import { toJid } from '../webhooks/jid.js';
import {
  contactPayload,
  eventPayload,
  locationPayload,
} from './rich-content.js';

/**
 * Media sent from a URL.
 * - sticker: a WebP image.
 * - videoNote: a short square video shown as a round video message.
 * - voiceNote: audio shown as a voice message (waveform bubble). Use OGG/Opus: other formats
 *   may not play on every phone.
 * - gif: a short MP4 that loops silently, like a GIF.
 * sticker, videoNote, voiceNote and audio have no caption, so content is ignored for them.
 */
export const MEDIA_TYPES = [
  'image',
  'video',
  'audio',
  'document',
  'sticker',
  'videoNote',
  'voiceNote',
  'gif',
] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/** Media that can be sent "view once": the recipient can open it one time. */
export const VIEW_ONCE_TYPES: readonly string[] = [
  'image',
  'video',
  'audio',
  'voiceNote',
];

/** Points at one message in a chat. */
export const messageRefSchema = z.object({
  messageId: z.string().min(1).max(128),
  /** true when the referenced message was sent by this account. */
  fromMe: z.boolean().optional(),
  /** In groups: who wrote the referenced message (phone or JID). */
  participant: z.string().min(1).max(64).optional(),
});

export const quoteSchema = messageRefSchema.extend({
  /** What WhatsApp shows inside the quote */
  text: z.string().max(1024).optional(),
});
export const reactionSchema = messageRefSchema.extend({
  /** "" removes the reaction */
  emoji: z.string().max(16),
});
export type ReactionInput = z.infer<typeof reactionSchema>;

/** Extras of a send. Stored as JSON in scheduled_messages.options for queued messages. */
export const sendOptionsShape = {
  /** image, video, audio, voiceNote: the recipient can open it only once */
  viewOnce: z.boolean().optional(),
  /** document: the file name the recipient sees. Default: the last part of the URL. */
  fileName: z.string().min(1).max(255).optional(),
  /** document, audio, voiceNote: the file's MIME type. Default: guessed from the URL. */
  mimetype: z
    .string()
    .max(128)
    .regex(/^[\w.+-]+\/[\w.+-]+(\s*;.*)?$/, 'Not a MIME type')
    .optional(),
  /** Phones or JIDs to @mention. Put "@<number>" in the text where each should appear. */
  mentions: z.array(z.string().min(1).max(64)).max(50).optional(),
  /** Show the message as a reply to this one */
  quote: quoteSchema.optional(),
};
export const sendOptionsSchema = z.object(sendOptionsShape);
export type SendOptions = z.infer<typeof sendOptionsSchema>;

/** Pick the send options out of a request; null when none is set. */
export function pickSendOptions(input: SendOptions): SendOptions | null {
  const out: SendOptions = {};
  if (input.viewOnce) out.viewOnce = true;
  if (input.fileName) out.fileName = input.fileName;
  if (input.mimetype) out.mimetype = input.mimetype;
  if (input.mentions?.length) out.mentions = input.mentions;
  if (input.quote) out.quote = input.quote;
  return Object.keys(out).length ? out : null;
}

/** Problems with options for this kind of message, as a sentence; null when fine. */
export function sendOptionsProblem(
  mediaType: string | null | undefined,
  options: SendOptions,
): string | null {
  if (options.viewOnce && !VIEW_ONCE_TYPES.includes(mediaType ?? ''))
    return 'viewOnce is for image, video, audio and voiceNote';
  if (options.fileName && mediaType !== 'document')
    return 'fileName is for documents';
  if (
    options.mimetype &&
    !['document', 'audio', 'voiceNote'].includes(mediaType ?? '')
  )
    return 'mimetype is for document, audio and voiceNote';
  return null;
}

export function parseSendOptions(raw?: string | null): SendOptions {
  if (!raw) return {};
  try {
    return sendOptionsSchema.parse(JSON.parse(raw));
  } catch {
    return {};
  }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg; codecs=opus',
  oga: 'audio/ogg; codecs=opus',
  opus: 'audio/ogg; codecs=opus',
  wav: 'audio/wav',
  amr: 'audio/amr',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  zip: 'application/zip',
  json: 'application/json',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

const urlFileName = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  } catch {
    return '';
  }
};
const guessMime = (name: string) =>
  MIME_BY_EXTENSION[name.split('.').pop()?.toLowerCase() ?? ''];

/**
 * Build the Baileys message for a text or a media URL. content becomes the caption for
 * image, video, gif and document; the other media have no caption in WhatsApp.
 */
export function buildMessagePayload(
  content: string,
  mediaUrl?: string | null,
  mediaType?: string | null,
  options: SendOptions = {},
): AnyMessageContent {
  // Stored like polls: the fields are JSON in content, there is no URL.
  if (mediaType === 'location') return locationPayload(JSON.parse(content));
  if (mediaType === 'contact') return contactPayload(JSON.parse(content));
  if (mediaType === 'event') return eventPayload(JSON.parse(content));

  const mentions = (options.mentions ?? [])
    .map((m) => toJid(m))
    .filter((m): m is string => !!m);
  const withMentions = mentions.length ? { mentions } : {};
  const viewOnce = options.viewOnce ? { viewOnce: true } : {};

  if (!mediaUrl || !mediaType) {
    return { text: content, ...withMentions };
  }
  // Baileys reads a non-http "url" as a local file path; only public http(s) URLs get through.
  assertPublicUrl(mediaUrl);

  switch (mediaType) {
    case 'image':
      return {
        image: { url: mediaUrl },
        caption: content,
        ...withMentions,
        ...viewOnce,
      };
    case 'video':
      return {
        video: { url: mediaUrl },
        caption: content,
        ...withMentions,
        ...viewOnce,
      };
    case 'gif':
      return {
        video: { url: mediaUrl },
        caption: content,
        gifPlayback: true,
        ...withMentions,
      };
    case 'audio':
      return {
        audio: { url: mediaUrl },
        mimetype:
          options.mimetype ?? guessMime(urlFileName(mediaUrl)) ?? 'audio/mp4',
        ...viewOnce,
      };
    case 'voiceNote':
      return {
        audio: { url: mediaUrl },
        ptt: true,
        mimetype: options.mimetype ?? 'audio/ogg; codecs=opus',
        ...viewOnce,
      };
    case 'sticker':
      return { sticker: { url: mediaUrl } };
    case 'videoNote':
      return { video: { url: mediaUrl }, ptv: true };
    case 'document': {
      const fileName = options.fileName ?? (urlFileName(mediaUrl) || 'file');
      return {
        document: { url: mediaUrl },
        caption: content,
        fileName,
        mimetype:
          options.mimetype ?? guessMime(fileName) ?? 'application/octet-stream',
        ...withMentions,
      };
    }
    default:
      return { text: content, ...withMentions };
  }
}

const participantJid = (p?: string) =>
  p ? (toJid(p) ?? undefined) : undefined;

/** The second argument of sendMessage: the quoted message, when there is one. */
export function relayOptions(
  jid: string,
  options: SendOptions = {},
): MiscMessageGenerationOptions | undefined {
  const q = options.quote;
  if (!q) return undefined;
  const quoted: WAMessage = {
    key: {
      remoteJid: jid,
      id: q.messageId,
      fromMe: !!q.fromMe,
      participant: participantJid(q.participant),
    },
    message: { conversation: q.text ?? '' },
  };
  return { quoted };
}

export function reactionPayload(
  jid: string,
  r: ReactionInput,
): AnyMessageContent {
  return {
    react: {
      text: r.emoji,
      key: {
        remoteJid: jid,
        id: r.messageId,
        fromMe: !!r.fromMe,
        participant: participantJid(r.participant),
      },
    },
  };
}
