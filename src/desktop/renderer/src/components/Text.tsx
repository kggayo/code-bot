import { memo } from 'react';
import type { ReactNode } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api.ts';
import { state } from '../state.ts';

const TASK_LINK = 'code-bot-task:';
const TASK_ID_GLOBAL = /\bt_[0-9a-f]{10}\b/g;
const TASK_ID_ONLY = /^t_[0-9a-f]{10}$/;

/** A sub-agent id that opens the sub-agent when clicked. */
export function TaskChip({ id }: { id: string }) {
  return (
    <button type="button" className="chip" onClick={() => state.openTask(id)} title="Open this sub-agent">
      {id}
    </button>
  );
}

/** Plain text with sub-agent ids turned into chips. Never interprets markup. */
export function RichText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TASK_ID_GLOBAL)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    parts.push(<TaskChip key={`${index}-${match[0]}`} id={match[0]} />);
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

/** Turns sub-agent ids in Markdown text (and in `code`) into links that open the sub-agent. */
function remarkTaskLinks() {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
    const next: MdNode[] = [];
    for (const child of node.children) {
      if (child.type === 'inlineCode' && child.value && TASK_ID_ONLY.test(child.value)) {
        next.push({ type: 'link', url: TASK_LINK + child.value, children: [child] });
      } else if (child.type === 'text' && child.value) {
        let last = 0;
        for (const match of child.value.matchAll(TASK_ID_GLOBAL)) {
          const index = match.index ?? 0;
          if (index > last) next.push({ type: 'text', value: child.value.slice(last, index) });
          next.push({ type: 'link', url: TASK_LINK + match[0], children: [{ type: 'text', value: match[0] }] });
          last = index + match[0].length;
        }
        if (last === 0) next.push(child);
        else if (last < child.value.length) next.push({ type: 'text', value: child.value.slice(last) });
      } else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  return (tree: MdNode) => walk(tree);
}

const components: Components = {
  a: ({ href, children }) => {
    if (href?.startsWith(TASK_LINK)) {
      const id = href.slice(TASK_LINK.length);
      return (
        <button type="button" className="chip" onClick={() => state.openTask(id)} title="Open this sub-agent">
          {children}
        </button>
      );
    }
    return (
      <a
        href={href}
        title={href}
        onClick={(event) => {
          event.preventDefault();
          if (href) void api.openExternal(href).catch(() => undefined);
        }}
      >
        {children}
      </a>
    );
  },
  // Remote images are never loaded.
  img: ({ alt }) => <span className="img-alt">[image{alt ? `: ${alt}` : ''}]</span>,
};

const urlTransform = (url: string) => (url.startsWith(TASK_LINK) ? url : defaultUrlTransform(url));

/** Agent output rendered as Markdown. Raw HTML in it is dropped, never rendered. */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm, remarkTaskLinks]} components={components} urlTransform={urlTransform} skipHtml>
        {text}
      </Markdown>
    </div>
  );
});
