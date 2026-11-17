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
