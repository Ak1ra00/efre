import { motion, useReducedMotion } from "motion/react";
import { useId } from "react";

import { cn } from "@/lib/utils";

/**
 * An original drawing of a USB security key: a rounded body with a key-ring hole, a
 * USB-C plug, a status light and a round touch pad with fingerprint-like ridges that
 * sends out soft rings. It is deliberately generic (no maker's logo, shape or colours).
 * Decorative.
 *
 * The rings and the light pulse only without reduced motion; with it, one ring is
 * drawn still.
 */
export function KeyIllustration({ className, pulse = true }: { className?: string; pulse?: boolean }) {
  const reduce = useReducedMotion() === true;
  const id = useId();
  const body = `${id}-body`;
  const plug = `${id}-plug`;
  const pad = `${id}-pad`;
  const shadow = `${id}-shadow`;
  const animate = pulse && !reduce;
  // Touch pad centre and radius.
  const cx = 122;
  const cy = 80;
  const r = 23;

  return (
    <svg viewBox="0 0 280 160" aria-hidden="true" className={cn("w-64", className)} fill="none">
      <defs>
        <linearGradient id={body} x1="0" y1="46" x2="0" y2="114" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#262830" />
          <stop offset="1" stopColor="#16171c" />
        </linearGradient>
        <linearGradient id={plug} x1="0" y1="64" x2="0" y2="96" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#62666f" />
          <stop offset="1" stopColor="#33353c" />
        </linearGradient>
        <radialGradient id={pad} cx={cx} cy={cy - 8} r={r + 6} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3b4080" />
          <stop offset="1" stopColor="#23264d" />
        </radialGradient>
        <radialGradient
          id={shadow}
          cx="140"
          cy="132"
          r="110"
          gradientTransform="matrix(1 0 0 0.12 0 116)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#000000" stopOpacity="0.6" />
          <stop offset="1" stopColor="#000000" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Soft floor shadow. */}
      <ellipse cx="140" cy="132" rx="112" ry="13" fill={`url(#${shadow})`} />

      {/* Rings from the touch pad (drawn first: the body hides their inner part). */}
      {animate ? (
        [0, 1].map((ring) => (
          <motion.circle
            key={ring}
            cx={cx}
            cy={cy}
            stroke="#8b93ff"
            strokeWidth="1.5"
            initial={{ r, opacity: 0 }}
            animate={{ r: [r, 66], opacity: [0.5, 0] }}
            transition={{ duration: 2.8, ease: "easeOut", repeat: Infinity, delay: ring * 1.4 }}
          />
        ))
      ) : (
        <circle cx={cx} cy={cy} r="44" stroke="#8b93ff" strokeOpacity="0.2" strokeWidth="1.5" />
      )}

      {/* USB-C plug. */}
      <rect x="214" y="64" width="36" height="32" rx="8" fill={`url(#${plug})`} />
      <rect x="214.75" y="64.75" width="34.5" height="30.5" rx="7.25" stroke="#ffffff" strokeOpacity="0.1" strokeWidth="1.5" />
      <rect x="225" y="74" width="19" height="12" rx="5" fill="#111216" />

      {/* Body. */}
      <rect x="30" y="46" width="192" height="68" rx="22" fill={`url(#${body})`} />
      <rect x="30.75" y="46.75" width="190.5" height="66.5" rx="21.25" stroke="#3b3e47" strokeWidth="1.5" />
      <path d="M 54 48.5 H 198" stroke="#ffffff" strokeOpacity="0.08" strokeWidth="1.5" strokeLinecap="round" />

      {/* Key-ring hole. */}
      <circle cx="56" cy="80" r="9" fill="#0c0d10" />
      <circle cx="56" cy="80" r="9" stroke="#3b3e47" strokeWidth="1.5" />

      {/* Touch pad with fingerprint-like ridges. */}
      <circle cx={cx} cy={cy} r={r} fill={`url(#${pad})`} />
      <circle cx={cx} cy={cy} r={r} stroke="#8b93ff" strokeOpacity="0.7" strokeWidth="1.5" />
      <g stroke="#b3b9ff" strokeOpacity="0.55" strokeWidth="1.5" strokeLinecap="round">
        <path d={`M ${String(cx - 13)} ${String(cy + 7)} A 15 15 0 0 1 ${String(cx + 14)} ${String(cy + 2)}`} />
        <path d={`M ${String(cx - 9)} ${String(cy + 10)} A 10 10 0 1 1 ${String(cx + 10)} ${String(cy + 4)}`} />
        <path d={`M ${String(cx - 4)} ${String(cy + 11)} A 5 5 0 1 1 ${String(cx + 5)} ${String(cy + 2)} V ${String(cy + 9)}`} />
        <path d={`M ${String(cx + 1)} ${String(cy)} V ${String(cy + 6)}`} />
      </g>

      {/* Status light. */}
      {animate ? (
        <motion.rect
          x="181"
          y="77"
          width="12"
          height="6"
          rx="3"
          fill="#a7adff"
          initial={{ opacity: 0.3 }}
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1.4, ease: "easeInOut", repeat: Infinity }}
        />
      ) : (
        <rect x="181" y="77" width="12" height="6" rx="3" fill="#a7adff" />
      )}
      <rect x="177" y="73" width="20" height="14" rx="7" stroke="#a7adff" strokeOpacity="0.14" strokeWidth="1.5" />
    </svg>
  );
}
