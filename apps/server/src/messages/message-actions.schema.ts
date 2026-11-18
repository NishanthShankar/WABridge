import { z } from 'zod';

/**
 * Which message to act on: the chat (chatId from a webhook, or a phone number) and the
 * WhatsApp messageId; or scheduledMessageId, the id POST /api/messages returned.
 */
const target = {
  chatId: z.string().min(1).max(64).optional(),
  phone: z.string().min(1).max(32).optional(),
  messageId: z.string().min(1).max(128).optional(),
  scheduledMessageId: z.string().min(1).max(64).optional(),
};

type Target = {
  chatId?: string;
  phone?: string;
  messageId?: string;
  scheduledMessageId?: string;
};

const oneTarget = (v: Target) =>
  v.scheduledMessageId
    ? !v.chatId && !v.phone && !v.messageId
    : !!v.messageId && !!v.chatId !== !!v.phone;
const oneTargetMessage = {
  message:
    'Give scheduledMessageId, or messageId with exactly one of chatId or phone',
};

export const editSentSchema = z
  .object({
    ...target,
    /** The new text. WhatsApp allows edits for 15 minutes after sending. */
    text: z.string().min(1).max(4096),
  })
  .refine(oneTarget, oneTargetMessage);

export const deleteSentSchema = z
  .object({
    ...target,
    /** false: someone else's message in a group where this account is admin. Default true. */
    fromMe: z.boolean().optional(),
    /** With fromMe false: who wrote it (phone or JID, from the webhook's from / fromLid). */
    participant: z.string().min(1).max(64).optional(),
  })
  .refine(oneTarget, oneTargetMessage)
  .refine(
    (v) => v.fromMe !== false || (!!v.participant && !v.scheduledMessageId),
    {
      message:
        "Deleting someone else's message needs participant (and chatId, not scheduledMessageId)",
      path: ['participant'],
    },
  );

export const forwardSchema = z
  .object({
    ...target,
    /** Where to forward it: a chat JID or a phone number. Exactly one. */
    toChatId: z.string().min(1).max(64).optional(),
    toPhone: z.string().min(1).max(32).optional(),
  })
  .refine(oneTarget, oneTargetMessage)
  .refine((v) => !!v.toChatId !== !!v.toPhone, {
    message: 'Give exactly one of toChatId or toPhone',
  });

export type EditSentInput = z.infer<typeof editSentSchema>;
export type DeleteSentInput = z.infer<typeof deleteSentSchema>;
export type ForwardInput = z.infer<typeof forwardSchema>;

export const starSchema = z
  .object({
    ...target,
    /** true: this account wrote it. Default false for chatId/phone, true for scheduledMessageId. */
    fromMe: z.boolean().optional(),
    /** true stars it, false unstars it */
    star: z.boolean(),
  })
  .refine(oneTarget, oneTargetMessage);
