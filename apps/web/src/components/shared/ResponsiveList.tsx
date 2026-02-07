import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface Column<T> {
  header: string;
  accessor: (row: T) => React.ReactNode;
  className?: string;
}

interface ResponsiveListProps<T extends { id: string }> {
  data: T[];
  columns: Column<T>[];
  onRowClick?: (row: T) => void;
  emptyState?: React.ReactNode;
}

export function ResponsiveList<T extends { id: string }>({
  data,
  columns,
  onRowClick,
  emptyState,
}: ResponsiveListProps<T>) {
  if (data.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <>
      {/* Desktop: Table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              {columns.map((col, i) => (
                <th
                  key={i}
                  className={cn(
                    'px-4 py-3 text-left font-medium text-muted-foreground',
                    col.className,
                  )}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr
                key={row.id}
                className={cn(
                  'border-b transition-colors hover:bg-muted/50',
                  onRowClick && 'cursor-pointer',
                )}
                onClick={() => onRowClick?.(row)}
              >
                {columns.map((col, i) => (
                  <td key={i} className={cn('px-4 py-3', col.className)}>
                    {col.accessor(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: Card list */}
      <div className="md:hidden flex flex-col gap-3">
        {data.map((row) => (
          <Card
            key={row.id}
            className={cn(
              'py-3 transition-colors',
              onRowClick && 'cursor-pointer hover:bg-muted/50',
            )}
            onClick={() => onRowClick?.(row)}
          >
            <CardContent className="space-y-2">
              {columns.map((col, i) => (
                <div key={i} className="flex items-start justify-between gap-2">
                  <span className="text-xs text-muted-foreground shrink-0">
                    {col.header}
                  </span>
                  <span className="text-sm text-right">{col.accessor(row)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
