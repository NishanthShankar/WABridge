import { describe, expect, it } from 'vitest';
import { createDocsRouter } from '../api/docs.js';

describe('GET /api/docs', () => {
  it('returns the API reference as markdown with extension docs appended', async () => {
    const router = createDocsRouter([
      { name: '@acme/x', docs: '## X\n\nPOST /api/x' },
      { name: '@acme/y', docs: async () => '## Y' },
      { name: '@acme/z' },
    ]);
    const res = await router.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const md = await res.text();
    expect(md).toContain('### POST /api/reply');
    expect(md).toContain('## Polls');
    expect(md).toContain('# Extension: @acme/x\n\n## X\n\nPOST /api/x');
    expect(md).toContain('# Extension: @acme/y\n\n## Y');
    expect(md).not.toContain('@acme/z');
  });
});

describe('GET /api/docs sections', () => {
  const router = createDocsRouter([
    { name: '@acme/x', docs: '## X things\n\nPOST /api/x' },
  ]);

  it('lists the sections with ids', async () => {
    const res = await router.request('/sections');
    const { sections } = (await res.json()) as {
      sections: Array<{ id: string; source: string }>;
    };
    const ids = sections.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'polls',
        'reply-lane',
        'creating-and-managing-groups',
        'x-things',
      ]),
    );
    expect(sections.find((s) => s.id === 'x-things')?.source).toBe('@acme/x');
    // headings inside code blocks ("# new tenant") are not sections
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns only the asked sections, with the auth intro', async () => {
    const res = await router.request('/?section=polls,X%20things');
    expect(res.status).toBe(200);
    const md = await res.text();
    expect(md).toContain('X-API-Key');
    expect(md).toContain('## Polls');
    expect(md).toContain('POST /api/x');
    expect(md).not.toContain('## Reply lane');
    expect(md).not.toContain('## Contacts');
  });

  it('404s an unknown section and lists the valid ids', async () => {
    const res = await router.request('/?section=polls,nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; sections: string[] };
    expect(body.error).toBe('unknown_section');
    expect(body.sections).toContain('polls');
  });
});
