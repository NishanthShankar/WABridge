import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import type { Extension } from '../extensions.js';

/** The API reference in this repo. Read on every request, so doc edits show without a restart. */
const API_DOC = resolve(import.meta.dirname, '../../../../docs/API.md');

export interface DocSection {
  /** Slug of the heading: "Reply lane" -> "reply-lane" */
  id: string;
  title: string;
  /** "core", or the extension's package name */
  source: string;
  markdown: string;
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Split markdown at its "## " headings (ignoring lines inside ``` code blocks). Text before
 * the first heading is returned as the preamble.
 */
export function splitSections(
  markdown: string,
  source: string,
): { preamble: string; sections: DocSection[] } {
  const lines = markdown.split('\n');
  const preamble: string[] = [];
  const sections: DocSection[] = [];
  let current: { title: string; lines: string[] } | null = null;
  let inFence = false;
  const flush = () => {
    if (!current) return;
    sections.push({
      id: slugify(current.title),
      title: current.title,
      source,
      markdown: current.lines.join('\n').trim(),
    });
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = !inFence && /^## (.+)$/.exec(line);
    if (heading) {
      flush();
      current = { title: heading[1].trim(), lines: [line] };
    } else if (current) current.lines.push(line);
    else preamble.push(line);
  }
  flush();
  return { preamble: preamble.join('\n').trim(), sections };
}

/** The core reference and every extension's docs, as one list of sections. */
async function loadDocs(extensions: Extension[]) {
  const base = await readFile(API_DOC, 'utf8');
  const { preamble, sections } = splitSections(base, 'core');
  for (const ext of extensions) {
    const docs = typeof ext.docs === 'function' ? await ext.docs() : ext.docs;
    if (!docs?.trim()) continue;
    const split = splitSections(docs, ext.name);
    if (split.preamble)
      sections.push({
        id: slugify(ext.name),
        title: ext.name,
        source: ext.name,
        markdown: `## ${ext.name}\n\n${split.preamble}`,
      });
    sections.push(...split.sections);
  }
  // Two sections with the same heading get -2, -3 ... so every id is unique.
  const seen = new Map<string, number>();
  for (const s of sections) {
    const n = (seen.get(s.id) ?? 0) + 1;
    seen.set(s.id, n);
    if (n > 1) s.id = `${s.id}-${n}`;
  }
  return { preamble, sections };
}

const MARKDOWN = {
  'Content-Type': 'text/markdown; charset=utf-8',
  'Cache-Control': 'no-store',
};

/**
 * The API reference for agents and people building against this server, behind the API key
 * like the rest of /api (so private extension docs are not public).
 *
 * - GET /api/docs: everything, as one markdown document
 * - GET /api/docs?section=polls,reply-lane: only those sections (plus the base URL and auth intro)
 * - GET /api/docs/sections: the section ids and titles, as JSON
 */
export function createDocsRouter(extensions: Extension[]) {
  const router = new Hono();

  const load = async () => {
    try {
      return await loadDocs(extensions);
    } catch {
      return null;
    }
  };
  const unavailable = {
    error: 'docs_unavailable',
    message: 'docs/API.md not found on this server',
  };

  router.get('/sections', async (c) => {
    const docs = await load();
    if (!docs) return c.json(unavailable, 503);
    return c.json({
      sections: docs.sections.map((s) => ({
        id: s.id,
        title: s.title,
        source: s.source,
        bytes: Buffer.byteLength(s.markdown),
      })),
    });
  });

  router.get('/', async (c) => {
    const docs = await load();
    if (!docs) return c.json(unavailable, 503);
    const wanted = (c.req.query('section') ?? c.req.query('sections') ?? '')
      .split(',')
      .map((s) => slugify(s))
      .filter(Boolean);

    let chosen = docs.sections;
    if (wanted.length) {
      const byId = new Map(docs.sections.map((s) => [s.id, s]));
      const unknown = wanted.filter((id) => !byId.has(id));
      if (unknown.length)
        return c.json(
          {
            error: 'unknown_section',
            message: `No section: ${unknown.join(', ')}`,
            sections: docs.sections.map((s) => s.id),
          },
          404,
        );
      chosen = [...new Set(wanted)].map((id) => byId.get(id) as DocSection);
    }

    const parts = [docs.preamble];
    let source = 'core';
    for (const s of chosen) {
      if (s.source !== source && !wanted.length)
        parts.push(`---\n\n# Extension: ${s.source}`);
      source = s.source;
      parts.push(s.markdown);
    }
    return c.body(`${parts.join('\n\n')}\n`, 200, MARKDOWN);
  });

  return router;
}
