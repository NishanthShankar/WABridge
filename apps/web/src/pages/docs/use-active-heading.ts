import { useEffect, useState } from 'react';
import type { TocEntry } from './parse-headings';

export function useActiveHeading(entries: TocEntry[]): string {
  const [activeId, setActiveId] = useState('');

  useEffect(() => {
    const ids = entries.map((e) => e.id);
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);

    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (intersections) => {
        for (const entry of intersections) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
            break;
          }
        }
      },
      { rootMargin: '-80px 0px -70% 0px' },
    );

    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [entries]);

  return activeId;
}
