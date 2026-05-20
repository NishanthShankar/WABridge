import { type ReactNode, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { slugify, markdown } from './parse-headings';

function extractText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractText).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    return extractText((children as { props: { children?: ReactNode } }).props.children);
  }
  return '';
}

const components = {
  h2: ({ children }: { children?: ReactNode }) => {
    const text = extractText(children);
    const id = slugify(text);
    return (
      <h2 id={id} className="scroll-mt-20">
        {children}
      </h2>
    );
  },
  h3: ({ children }: { children?: ReactNode }) => {
    const text = extractText(children);
    const id = slugify(text);
    return (
      <h3 id={id} className="scroll-mt-20">
        {children}
      </h3>
    );
  },
};

export function DocsContent() {
  const content = useMemo(() => {
    const origin = window.location.origin;
    const wsOrigin = origin.replace(/^http/, 'ws');
    return markdown
      .split('http://localhost:4000').join(origin)
      .split('ws://localhost:4000').join(wsOrigin);
  }, []);

  return (
    <article className="prose dark:prose-invert max-w-none px-4 py-8 md:px-8">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </article>
  );
}
