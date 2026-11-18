import { z } from 'zod';
import { POLL_MODES } from '../polls/polls.js';
import {
  MEDIA_TYPES,
  pickSendOptions,
  quoteSchema,
  reactionSchema,
  sendOptionsProblem,
  sendOptionsShape,
} from '../scheduler/message-payload.js';
import {
  contactSchema,
  eventSchema,
  groupInviteSchema,
  locationSchema,
  productSchema,
} from '../scheduler/rich-content.js';

/** Sent on their own, after any text: at most one per request. */
const RICH = ['location', 'contact', 'event', 'groupInvite', 'product'] as const;

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
    /** Send a map pin. Sent on its own, after any text. */
    location: locationSchema.optional(),
    /** Send a contact card, or up to 10 in one message. Sent on its own, after any text. */
    contact: contactSchema.optional(),
    /** Send a calendar event card. Sent on its own, after any text. */
    event: eventSchema.optional(),
    /** Send an invite card for a group this account is an admin of. Sent on its own, after any text. */
    groupInvite: groupInviteSchema.optional(),
    /** Business accounts: send a catalog product card. Sent on its own, after any text. */
    product: productSchema.optional(),
    /** viewOnce, fileName, mimetype, mentions: see POST /api/messages */
    ...sendOptionsShape,
    /** Show the answer as a reply to this message. text is what WhatsApp shows in the quote. */
    quote: quoteSchema.optional(),
    /** React to a message instead of (or as well as) sending text. emoji "" removes it. */
    reaction: reactionSchema.optional(),
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
        /**
         * Privacy: answers are never stored in the database or logs. Each vote is held in
         * memory until acknowledged (webhook 2xx or POST /api/polls/pending/ack), at most an hour.
         */
        stealth: z.boolean().optional(),
        /** Your own id for this poll, echoed in poll.vote. Not personal data. */
        ref: z.string().min(1).max(128).optional(),
        /** ISO time: delete for everyone then if nobody voted. Within 48 hours. */
        deleteAt: z
          .string()
          .datetime({ offset: true })
          .refine((t) => Date.parse(t) > Date.now(), {
            message: 'deleteAt must be in the future',
          })
          .refine((t) => Date.parse(t) <= Date.now() + 48 * 3_600_000, {
            message:
              'deleteAt must be within 48 hours: WhatsApp only deletes for everyone for about two days',
          })
          .optional(),
      })
      .optional(),
    /** Show "typing…" for a moment before the text. Default true. */
    typing: z.boolean().optional(),
    /**
     * Outside the 24 hour window, queue this through POST /api/messages (2-8 s delay, counts
     * toward the daily cap) instead of answering 409. A poll stays a poll for chats that have
     * written to this account before, and becomes numbered text for anyone else. reaction and typing are dropped when queued.
     * Use with care: see the docs.
     */
    dontSkip: z.boolean().optional(),
    /**
     * Outside the window, send the poll as a real poll (queued, like dontSkip). Only for chats
     * that have written to this account before. Use with care: see the docs.
     */
    forcePoll: z.boolean().optional(),
  })
  .refine((v) => !v.forcePoll || !!v.poll, {
    message: 'forcePoll needs a poll',
    path: ['forcePoll'],
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
  .refine(
    (v) => !!v.text || !!v.reaction || !!v.mediaUrl || !!v.poll || RICH.some((k) => !!v[k]),
    { message: `Give text, mediaUrl, poll, reaction, ${RICH.join(', ')} or a mix` },
  )
  .refine(
    (v) => [v.mediaUrl, v.poll, ...RICH.map((k) => v[k])].filter(Boolean).length <= 1,
    { message: `Send one of mediaUrl, poll, ${RICH.join(', ')} per request` },
  )
  .superRefine((v, ctx) => {
    const options = pickSendOptions({ ...v, mentions: undefined, quote: undefined });
    const problem = options && sendOptionsProblem(v.mediaUrl ? v.mediaType : null, options);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  })
  .refine((v) => !(v.poll && (v.text || v.mediaUrl)), {
    message: 'A poll is sent on its own: put the question in poll.name',
    path: ['poll'],
  });

export type ReplyInput = z.infer<typeof replySchema>;
