import type { AnyMessageContent } from '@whiskeysockets/baileys';

export const MEDIA_TYPES = ['image', 'video', 'audio', 'document'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/**
 * Build the Baileys message for a text or a media URL. content becomes the caption for
 * image, video and document; audio has no caption in WhatsApp, so content is ignored there.
 */
export function buildMessagePayload(
  content: string,
  mediaUrl?: string | null,
  mediaType?: string | null,
): AnyMessageContent {
  if (!mediaUrl || !mediaType) {
    return { text: content };
  }

  switch (mediaType) {
    case 'image':
      return { image: { url: mediaUrl }, caption: content };
    case 'video':
      return { video: { url: mediaUrl }, caption: content };
    case 'audio':
      return { audio: { url: mediaUrl }, mimetype: 'audio/mp4' };
    case 'document': {
      const fileName = decodeURIComponent(
        mediaUrl.split('/').pop()?.split('?')[0] ?? 'file',
      );
      return {
        document: { url: mediaUrl },
        caption: content,
        fileName,
        mimetype: 'application/octet-stream',
      };
    }
    default:
      return { text: content };
  }
}
