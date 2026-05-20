import { cn } from '@/lib/utils';
import type { HeadingNode } from './parse-headings';

interface DocsSidebarProps {
  tree: HeadingNode[];
  activeSectionId: string;
  open: boolean;
  onClose: () => void;
  onNav: (id: string) => void;
}

function SidebarContent({
  tree,
  activeSectionId,
  onNav,
}: Omit<DocsSidebarProps, 'open' | 'onClose'>) {
  return (
    <nav className="space-y-1 p-4">
      <h2 className="mb-3 text-sm font-semibold text-sidebar-foreground">Documentation</h2>
      {tree.map((node) => (
        <button
          key={node.id}
          onClick={() => onNav(node.id)}
          className={cn(
            'w-full rounded-md px-3 py-1.5 text-left text-sm transition-colors',
            activeSectionId === node.id
              ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
              : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
          )}
        >
          {node.label}
        </button>
      ))}
    </nav>
  );
}

export function DocsSidebar({ tree, activeSectionId, open, onClose, onNav }: DocsSidebarProps) {
  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:block sticky top-14 h-[calc(100vh-3.5rem)] w-64 shrink-0 overflow-y-auto border-r border-sidebar-border bg-sidebar">
        <SidebarContent tree={tree} activeSectionId={activeSectionId} onNav={onNav} />
      </aside>

      {/* Mobile overlay */}
      {open && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div className="fixed inset-0 bg-black/50" onClick={onClose} />
          <aside className="relative z-50 h-[calc(100%-4rem)] w-72 overflow-y-auto bg-sidebar">
            <SidebarContent tree={tree} activeSectionId={activeSectionId} onNav={onNav} />
          </aside>
        </div>
      )}
    </>
  );
}
