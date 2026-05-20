import { cn } from '@/lib/utils';
import type { TocEntry } from './parse-headings';

interface DocsTocProps {
  entries: TocEntry[];
  activeId: string;
  onNav: (id: string) => void;
}

export function DocsToc({ entries, activeId, onNav }: DocsTocProps) {
  if (entries.length === 0) return null;

  return (
    <aside className="hidden lg:block sticky top-14 h-[calc(100vh-3.5rem)] w-56 shrink-0 overflow-y-auto border-l p-4">
      <h3 className="mb-3 text-sm font-semibold">On this page</h3>
      <nav className="space-y-2">
        {entries.map((entry) => (
          <button
            key={entry.id}
            onClick={() => onNav(entry.id)}
            className={cn(
              'block w-full text-left text-xs transition-colors',
              activeId === entry.id
                ? 'font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {entry.label}
          </button>
        ))}
      </nav>
    </aside>
  );
}
