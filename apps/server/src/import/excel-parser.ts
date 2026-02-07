import * as XLSX from 'xlsx';

/**
 * Parse an Excel file buffer (.xlsx/.xls) into an array of row objects.
 * Reads the first sheet and converts to JSON with column headers.
 */
export function parseExcel(buffer: Buffer): Record<string, string>[] {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    return [];
  }

  const firstSheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json<Record<string, string>>(firstSheet);
}
