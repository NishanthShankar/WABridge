import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import type { Extension } from '../extensions.js';

/** The API reference in this repo. Read on every request, so doc edits show without a restart. */
const API_DOC = resolve(import.meta.dirname, '../../../../docs/API.md');

/**
 * GET /api/docs: the whole API reference as one markdown document, for agents and people
 * building against this server. Includes the docs of every loaded extension. Behind the
 * API key like the rest of /api, so private extension docs are not public.
 */
export function createDocsRouter(extensions: Extension[]) {
  const router = new Hono();

  router.get('/', async (c) => {
    let base: string;
    try {
      base = await readFile(API_DOC, 'utf8');
    } catch {
      return c.json(
        {
          error: 'docs_unavailable',
          message: 'docs/API.md not found on this server',
        },
        503,
      );
    }
    const parts = [base.trimEnd()];
    for (const ext of extensions) {
      const docs = typeof ext.docs === 'function' ? await ext.docs() : ext.docs;
      if (docs?.trim())
        parts.push(`---\n\n# Extension: ${ext.name}\n\n${docs.trim()}`);
    }
    return c.body(`${parts.join('\n\n')}\n`, 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  });

  return router;
}
