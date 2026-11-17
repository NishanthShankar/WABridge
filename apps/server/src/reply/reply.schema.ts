import { z } from 'zod';
import { POLL_MODES } from '../polls/polls.js';
import { MEDIA_TYPES } from '../scheduler/message-payload.js';

const messageRef = z.object({
  messageId: z.string().min(1).max(128),
  /** true when the referenced message was sent by this account. */
  fromMe: z.boolean().optional(),
  /** In groups: who wrote the referenced message (phone or JID). */
  participant: z.string().min(1).max(64).optional(),
});

export const replySchema = z
  .object({
    /** The chat to answer: a JID from a webhook's chatId, or a phone number. */
    chatId: z.string().min(1).max(64).optional(),
    phone: z.string().min(1).max(32).optional(),
    /** The message, or the caption when mediaUrl is given. */
    text: z.string().min(1).max(4096).optional(),
    /** Public http(s) URL of an image, video, audio or document to send. */
    mediaUrl: z.string().url().max(2048).optional(),
    mediaType: z.enum(MEDIA_TYPES).optional(),
    /** Show the answer as a reply to this message. text is what WhatsApp shows in the quote. */
    quote: messageRef
      .extend({ text: z.string().max(1024).optional() })
      .optional(),
    /** Phones or JIDs to @mention. Put "@<number>" in text where each should appear. */
    mentions: z.array(z.string().min(1).max(64)).max(50).optional(),
    /** React to a message instead of (or as well as) sending text. emoji "" removes it. */
    reaction: messageRef.extend({ emoji: z.string().max(16) }).optional(),
    /** Send a poll. options: 2-12 distinct choices. multiple: allow picking more than one. Votes come back as poll.vote webhooks. */
    poll: z
      .object({
        name: z.string().min(1).max(255),
        options: z
          .array(z.string().min(1).max(100))
          .min(2)
          .max(12)
          .refine((o) => new Set(o).size === o.length, {
            message: 'Poll options must be distinct',
          }),
        multiple: z.boolean().optional(),
        /** updateEveryTime (default) | lockFirstVote | deleteAfterVote */
        mode: z.enum(POLL_MODES).optional(),
        /** Reaction after a counted vote, or false for none. Default 👍. Not used by deleteAfterVote. */
        react: z
          .union([z.string().min(1).max(16), z.literal(false)])
          .optional(),
        /** Sent after a counted vote, or false for none. {{option}}, {{poll}}. deleteAfterVote default: "You chose {{option}}". */
        confirmText: z
          .union([z.string().min(1).max(1024), z.literal(false)])
          .optional(),
      })
      .optional(),
    /** Show "typing…"for a moment before the text. Default true. */
    typing: z.boolean().optional(),
  })
  .refine((v) => !!v.chatId !== !!v.phone, {
    message: 'Give exactly one of chatId or phone',
  })
  .refine((v) => !v.mediaUrl || !!v.mediaType, {
    message: 'mediaType is required when mediaUrl is given',
    path: ['mediaType'],
  })
  .refine((v) => !v.mediaType || !!v.mediaUrl, {
    message: 'mediaUrl is required when mediaType is given',
    path: ['mediaUrl'],
  })
  .refine((v) => !(v.mediaUrl && /^https?:/i.test(v.mediaUrl) === false), {
    message: 'mediaUrl must be http or https',
    path: ['mediaUrl'],
  })
  .refine((v) => !!v.text || !!v.reaction || !!v.mediaUrl || !!v.poll, {
    message: 'Give text, mediaUrl, poll, reaction or a mix',
  })
  .refine((v) => !(v.poll && (v.text || v.mediaUrl)), {
    message: 'A poll is sent on its own: put the question in poll.name',
    path: ['poll'],
  });

export type ReplyInput = z.infer<typeof replySchema>;
