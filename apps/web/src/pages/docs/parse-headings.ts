import content from '../../../../../docs/API.md?raw';

export interface TocEntry {
  id: string;
  text: string;
  label: string;
  level: 2 | 3;
}

export interface HeadingNode {
  id: string;
  text: string;
  label: string;
  children: { id: string; text: string; label: string }[];
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Map endpoint headings to short descriptions for nav */
const endpointLabels: Record<string, string> = {
  'GET /api/health': 'Check server health',
  'POST /api/contacts': 'Create a contact',
  'GET /api/contacts': 'List all contacts',
  'GET /api/contacts/:id': 'Get contact by ID',
  'PUT /api/contacts/:id': 'Update a contact',
  'DELETE /api/contacts/:id': 'Delete a contact',
  'POST /api/contacts/import': 'Bulk import contacts',
  'POST /api/contacts/:id/labels': 'Add label to contact',
  'DELETE /api/contacts/:id/labels/:labelId': 'Remove label from contact',
  'POST /api/labels': 'Create a label',
  'GET /api/labels': 'List all labels',
  'PUT /api/labels/:id': 'Update a label',
  'DELETE /api/labels/:id': 'Delete a label',
  'POST /api/templates': 'Create a template',
  'GET /api/templates': 'List all templates',
  'GET /api/templates/:id': 'Get template by ID',
  'PUT /api/templates/:id': 'Update a template',
  'DELETE /api/templates/:id': 'Delete a template',
  'POST /api/templates/:id/preview': 'Preview rendered template',
  'POST /api/groups/sync': 'Sync groups from WhatsApp',
  'GET /api/groups': 'List all groups',
  'GET /api/groups/:id': 'Get group by ID',
  'POST /api/messages': 'Send a message',
  'POST /api/messages/bulk': 'Bulk send messages',
  'GET /api/messages': 'List all messages',
  'GET /api/messages/:id': 'Get message by ID',
  'PATCH /api/messages/:id': 'Update a scheduled message',
  'PATCH /api/messages/:id/cancel': 'Cancel a scheduled message',
  'POST /api/messages/:id/retry': 'Retry a failed message',
  'POST /api/messages/recurring': 'Create a recurring rule',
  'GET /api/messages/recurring': 'List recurring rules',
  'GET /api/messages/recurring/:id': 'Get recurring rule by ID',
  'PATCH /api/messages/recurring/:id': 'Update a recurring rule',
  'DELETE /api/messages/recurring/:id': 'Delete a recurring rule',
  'GET /api/rate-limit/status': 'Check rate limit status',
  'POST /api/webhooks': 'Create a webhook',
  'GET /api/webhooks': 'List all webhooks',
  'GET /api/webhooks/:id': 'Get webhook by ID',
  'PUT /api/webhooks/:id': 'Update a webhook',
  'DELETE /api/webhooks/:id': 'Delete a webhook',
};

function labelFor(text: string): string {
  return endpointLabels[text] ?? text;
}

export function parseHeadings(md: string) {
  const flat: TocEntry[] = [];
  const tree: HeadingNode[] = [];
  const re = /^(#{2,3})\s+(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = re.exec(md)) !== null) {
    const level = match[1]!.length as 2 | 3;
    const text = match[2]!.trim();
    const id = slugify(text);
    const label = labelFor(text);

    flat.push({ id, text, label, level });

    if (level === 2) {
      tree.push({ id, text, label, children: [] });
    } else if (tree.length > 0) {
      tree[tree.length - 1]!.children.push({ id, text, label });
    }
  }

  return { flat, tree };
}

export const markdown = content;
export const headings = parseHeadings(content);
