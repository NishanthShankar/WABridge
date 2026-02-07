import { useState, useCallback, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Upload, FileSpreadsheet, CheckCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Wizard } from '@/components/shared/Wizard';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

interface ImportWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface PreviewData {
  headers: string[];
  rows: string[][];
  totalRows: number;
}

export function ImportWizard({ open, onOpenChange }: ImportWizardProps) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [importResult, setImportResult] = useState<{
    imported: number;
    skipped: number;
  } | null>(null);

  const importMutation = useMutation({
    mutationFn: (f: File) => api.contacts.import(f),
    onSuccess: (data) => {
      setImportResult({
        imported: data.imported ?? data.count ?? 0,
        skipped: data.skipped ?? 0,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all });
      toast.success('Contacts imported successfully');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Import failed');
    },
  });

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files?.[0] ?? null;
      setFile(selected);
      setPreview(null);
      setImportResult(null);

      if (selected) {
        parsePreview(selected);
      }
    },
    [],
  );

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files[0] ?? null;
    if (
      dropped &&
      (dropped.name.endsWith('.csv') ||
        dropped.name.endsWith('.xlsx') ||
        dropped.name.endsWith('.xls'))
    ) {
      setFile(dropped);
      setPreview(null);
      setImportResult(null);
      parsePreview(dropped);
    }
  }, []);

  function parsePreview(f: File) {
    // Client-side CSV preview (basic parsing for CSV, show raw for Excel)
    if (f.name.endsWith('.csv')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        const lines = text.split('\n').filter((l) => l.trim());
        const headers = lines[0]?.split(',').map((h) => h.trim().replace(/^"|"$/g, '')) ?? [];
        const rows = lines.slice(1, 6).map((line) =>
          line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, '')),
        );
        setPreview({ headers, rows, totalRows: lines.length - 1 });
      };
      reader.readAsText(f);
    } else {
      // For Excel files, show basic file info (server handles parsing)
      setPreview({
        headers: ['(Excel file - column preview on server)'],
        rows: [],
        totalRows: 0,
      });
    }
  }

  function handleReset() {
    setFile(null);
    setPreview(null);
    setImportResult(null);
  }

  const steps = useMemo(
    () => [
      {
        title: 'Upload',
        component: (
          <div className="space-y-4">
            <div
              className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-muted-foreground/25 p-8 text-center transition-colors hover:border-muted-foreground/50"
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
            >
              <Upload className="mb-3 size-10 text-muted-foreground" />
              <p className="text-sm font-medium">
                Drag and drop your file here
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Supports .csv, .xlsx, .xls files
              </p>
              <label className="mt-4">
                <Button variant="outline" size="sm" asChild>
                  <span>Browse Files</span>
                </Button>
                <input
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={handleFileSelect}
                  className="sr-only"
                />
              </label>
            </div>

            {file && (
              <div className="flex items-center gap-3 rounded-md border bg-muted/50 p-3">
                <FileSpreadsheet className="size-5 text-primary" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {(file.size / 1024).toFixed(1)} KB
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={handleReset}>
                  Remove
                </Button>
              </div>
            )}
          </div>
        ),
        validate: () => {
          if (!file) {
            toast.error('Please select a file to upload');
            return false;
          }
          return true;
        },
      },
      {
        title: 'Preview',
        component: (
          <div className="space-y-4">
            {preview ? (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">
                    File preview
                  </p>
                  {preview.totalRows > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {preview.totalRows} row{preview.totalRows !== 1 ? 's' : ''} found
                    </p>
                  )}
                </div>

                {preview.rows.length > 0 ? (
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/50">
                          {preview.headers.map((h, i) => (
                            <th
                              key={i}
                              className="px-3 py-2 text-left text-xs font-medium text-muted-foreground"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((row, ri) => (
                          <tr key={ri} className="border-b">
                            {row.map((cell, ci) => (
                              <td key={ci} className="px-3 py-2 text-xs">
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Excel file selected. Full preview will be available after import.
                  </p>
                )}

                <p className="text-xs text-muted-foreground">
                  Showing first {Math.min(5, preview.rows.length)} rows. Column
                  headers will be auto-mapped to contact fields.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Loading preview...
              </p>
            )}
          </div>
        ),
        validate: () => true,
      },
      {
        title: 'Import',
        component: (
          <div className="space-y-4">
            {importResult ? (
              <div className="flex flex-col items-center gap-3 py-4">
                <CheckCircle className="size-12 text-green-500" />
                <p className="text-lg font-medium">Import Complete</p>
                <div className="text-sm text-muted-foreground text-center">
                  <p>
                    {importResult.imported} contact
                    {importResult.imported !== 1 ? 's' : ''} imported
                  </p>
                  {importResult.skipped > 0 && (
                    <p>
                      {importResult.skipped} skipped (duplicates)
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 py-4">
                <FileSpreadsheet className="size-10 text-primary" />
                <p className="text-sm font-medium">
                  Ready to import{' '}
                  {preview?.totalRows
                    ? `${preview.totalRows} contact${preview.totalRows !== 1 ? 's' : ''}`
                    : 'contacts'}
                </p>
                <p className="text-xs text-muted-foreground text-center max-w-sm">
                  Duplicate phone numbers will be skipped. Column headers will
                  be automatically mapped to contact fields.
                </p>
              </div>
            )}
          </div>
        ),
        validate: () => true,
      },
    ],
    [file, preview, importResult, handleDrop, handleFileSelect],
  );

  async function handleComplete() {
    if (importResult) {
      // Already imported, just close
      onOpenChange(false);
      handleReset();
      return;
    }

    if (!file) return;

    await importMutation.mutateAsync(file);
  }

  function handleCancel() {
    onOpenChange(false);
    handleReset();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleCancel(); else onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import Contacts</DialogTitle>
        </DialogHeader>
        <Wizard
          steps={steps}
          onComplete={handleComplete}
          onCancel={handleCancel}
          completeLabel={importResult ? 'Done' : 'Import'}
        />
      </DialogContent>
    </Dialog>
  );
}
