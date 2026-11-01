import { type ComponentProps, useId } from "react";

import { cn } from "@/lib/utils";

/**
 * efre's mark (same artwork as src-tauri/icons/icon.svg): a lowercase "e" whose crossbar
 * extends into a key blade. Decorative unless you pass `title`.
 */
export function EfreMark({ className, title, ...props }: ComponentProps<"svg"> & { title?: string }) {
  const id = useId();
  const bg = `${id}-bg`;
  const glyph = `${id}-glyph`;
  return (
    <svg
      viewBox="0 0 1024 1024"
      role={title === undefined ? undefined : "img"}
      aria-hidden={title === undefined ? true : undefined}
      className={cn("size-8", className)}
      {...props}
    >
      {title === undefined ? null : <title>{title}</title>}
      <defs>
        <linearGradient id={bg} gradientUnits="userSpaceOnUse" x1="512" y1="48" x2="512" y2="976">
          <stop offset="0" stopColor="#1c1e24" />
          <stop offset="1" stopColor="#0c0d10" />
        </linearGradient>
        <linearGradient id={glyph} gradientUnits="userSpaceOnUse" x1="202" y1="260" x2="812" y2="760">
          <stop offset="0" stopColor="#b3b9ff" />
          <stop offset="1" stopColor="#7a83f5" />
        </linearGradient>
      </defs>
      <rect x="48" y="48" width="928" height="928" rx="208" fill={`url(#${bg})`} />
      <rect x="52" y="52" width="920" height="920" rx="204" fill="none" stroke="#2c2f37" strokeWidth="8" />
      <g
        transform="translate(-48 0)"
        fill="none"
        stroke={`url(#${glyph})`}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M 682 512 A 190 190 0 1 0 638 654" strokeWidth="80" />
        <path d="M 340 512 H 852" strokeWidth="72" />
        <path d="M 764 512 V 604 M 846 512 V 580" strokeWidth="56" />
      </g>
    </svg>
  );
}
