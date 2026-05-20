import { useCallback, useMemo, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { headings } from './parse-headings';
import { useActiveHeading } from './use-active-heading';
import { DocsSidebar } from './DocsSidebar';
import { DocsContent } from './DocsContent';
import { DocsToc } from './DocsToc';

export function DocsPage() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const activeId = useActiveHeading(headings.flat);

  // Find the active h2 section (even when an h3 is intersecting)
  const activeSectionId = useMemo(() => {
    for (const node of headings.tree) {
      if (node.id === activeId) return node.id;
      if (node.children.some((c) => c.id === activeId)) return node.id;
    }
    return headings.tree[0]?.id ?? '';
  }, [activeId]);

  // Filter TOC to only h3s under the active h2 section
  const tocEntries = useMemo(() => {
    const section = headings.tree.find((n) => n.id === activeSectionId);
    if (!section) return [];
    return section.children.map((c) => ({
      id: c.id,
      text: c.text,
      label: c.label,
      level: 3 as const,
    }));
  }, [activeSectionId]);

  const handleNavClick = useCallback((id: string) => {
    setSidebarOpen(false);
    const el = document.getElementById(id);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 80;
    window.scrollTo({ top, behavior: 'smooth' });
  }, []);

  return (
    <>
      <div className="flex min-h-[calc(100vh-3.5rem)]">
        <DocsSidebar
          tree={headings.tree}
          activeSectionId={activeSectionId}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onNav={handleNavClick}
        />

        <main className="min-w-0 flex-1">
          <DocsContent />
        </main>

        <DocsToc entries={tocEntries} activeId={activeId} onNav={handleNavClick} />
      </div>

      {/* Mobile FAB */}
      <button
        onClick={() => setSidebarOpen((o) => !o)}
        className="md:hidden fixed bottom-20 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
      >
        {sidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>
    </>
  );
}
