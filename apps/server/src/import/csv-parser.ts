import Papa from 'papaparse';

/**
 * Parse a CSV file buffer into an array of row objects.
 * Uses PapaParse with header mode (first row = column names).
 * Handles BOM, quoted fields, and various CSV dialects.
 */
export function parseCsv(buffer: Buffer): Record<string, string>[] {
  const text = buffer.toString('utf-8');
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  return result.data;
}
