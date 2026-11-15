import { z } from 'zod';

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
    text: z.string().min(1).max(4096).optional(),
    /** Show the answer as a reply to this message. text is what WhatsApp shows in the quote. */
    quote: messageRef
      .extend({ text: z.string().max(1024).optional() })
      .optional(),
    /** Phones or JIDs to @mention. Put "@<number>" in text where each should appear. */
    mentions: z.array(z.string().min(1).max(64)).max(50).optional(),
    /** React to a message instead of (or as well as) sending text. emoji "" removes it. */
    reaction: messageRef.extend({ emoji: z.string().max(16) }).optional(),
    /** Show "typing…" for a moment before the text. Default true. */
    typing: z.boolean().optional(),
  })
  .refine((v) => !!v.chatId !== !!v.phone, {
    message: 'Give exactly one of chatId or phone',
  })
  .refine((v) => !!v.text || !!v.reaction, {
    message: 'Give text, reaction or both',
  });

export type ReplyInput = z.infer<typeof replySchema>;
