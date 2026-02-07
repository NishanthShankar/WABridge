import { Hono } from 'hono';
import { parseCsv } from './csv-parser.js';
import { parseExcel } from './excel-parser.js';
import { createContactsService } from '../contacts/contacts.service.js';
import { getContext } from '../context.js';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Create the import API router.
 *
 * Routes:
 * - POST / - Import contacts from CSV or Excel file upload
 *
 * Expects multipart/form-data with a 'file' field.
 * Supported formats: .csv, .xlsx, .xls
 * Max file size: 5MB
 */
export function createImportRouter() {
  const router = new Hono();

  router.post('/', async (c) => {
    const { db } = getContext(c);
    const service = createContactsService(db);

    const body = await c.req.parseBody();
    const file = body['file'];

    if (!(file instanceof File)) {
      return c.json({ error: 'No file uploaded. Send a multipart form with a "file" field.' }, 400);
    }

    if (file.size > MAX_FILE_SIZE) {
      return c.json({ error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.` }, 400);
    }

    const filename = file.name.toLowerCase();
    const buffer = Buffer.from(await file.arrayBuffer());

    let rows: Record<string, string>[];

    if (filename.endsWith('.csv')) {
      rows = parseCsv(buffer);
    } else if (filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
      rows = parseExcel(buffer);
    } else {
      return c.json({ error: 'Unsupported file type. Use .csv, .xlsx, or .xls' }, 400);
    }

    if (rows.length === 0) {
      return c.json({ imported: 0, skipped: 0, errors: ['File contains no data rows'] });
    }

    const result = service.importContacts(rows);
    return c.json(result);
  });

  return router;
}
