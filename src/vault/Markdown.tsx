import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";

/**
 * A secure note's body. CommonMark only, rendered as text-only React elements:
 * - raw HTML is dropped (`skipHtml`), never rendered;
 * - images are not rendered (efre loads nothing, and the CSP blocks remote images);
 * - links are plain text with their address shown: efre never navigates or opens URLs.
 * Headings start at h3, below the item title (h2).
 */
const components: Components = {
  h1: ({ children }) => <h3 className="mt-5 mb-2 text-lg font-semibold tracking-tight first:mt-0">{children}</h3>,
  h2: ({ children }) => <h4 className="mt-5 mb-2 text-base font-semibold tracking-tight first:mt-0">{children}</h4>,
  h3: ({ children }) => <h5 className="mt-4 mb-1.5 text-sm font-semibold first:mt-0">{children}</h5>,
  h4: ({ children }) => <h6 className="mt-4 mb-1.5 text-sm font-semibold text-fg-muted first:mt-0">{children}</h6>,
  h5: ({ children }) => <h6 className="mt-3 mb-1 text-sm font-medium text-fg-muted first:mt-0">{children}</h6>,
  h6: ({ children }) => <h6 className="mt-3 mb-1 text-sm font-medium text-fg-muted first:mt-0">{children}</h6>,
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 flex list-disc flex-col gap-1 pl-5 marker:text-fg-subtle">{children}</ul>,
  ol: ({ children }) => (
    <ol className="my-2 flex list-decimal flex-col gap-1 pl-5 marker:text-fg-subtle">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-line-strong pl-3 text-fg-muted">{children}</blockquote>
  ),
  hr: () => <hr className="my-4 border-line" />,
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ children }) => (
    <code className="rounded-[4px] bg-hover px-1 py-0.5 font-mono text-[0.85em] text-fg">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-md border border-line bg-canvas p-3 font-mono text-[13px] leading-5 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[13px]">
      {children}
    </pre>
  ),
  a: ({ children, href }) => <PlainLink href={href}>{children}</PlainLink>,
};

function PlainLink({ href, children }: { href: string | undefined; children?: ReactNode }) {
  const text = typeof children === "string" ? children : null;
  const showAddress = href !== undefined && href !== "" && text !== href;
  return (
    <span className="text-accent-text">
      {children}
      {showAddress ? <span className="text-fg-subtle"> ({href})</span> : null}
    </span>
  );
}

export function NoteMarkdown({ text }: { text: string }) {
  return (
    <div className="text-sm leading-6 break-words text-fg">
      <ReactMarkdown skipHtml disallowedElements={["img"]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
