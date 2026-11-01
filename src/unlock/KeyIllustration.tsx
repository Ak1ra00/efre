import { motion, useReducedMotion } from "motion/react";
import { useId } from "react";

import { cn } from "@/lib/utils";

/**
 * An original drawing of a USB security key: a rounded body with a key-ring hole, a
 * USB-C plug, a status light and a round touch pad that sends out soft rings. It is
 * deliberately generic (no maker's logo, shape or colours). Decorative.
 *
 * The rings pulse only without reduced motion; with it, one ring is drawn still.
 */
export function KeyIllustration({ className, pulse = true }: { className?: string; pulse?: boolean }) {
  const reduce = useReducedMotion() === true;
  const id = useId();
  const body = `${id}-body`;
  const plug = `${id}-plug`;
  const pad = `${id}-pad`;
  const shadow = `${id}-shadow`;
  const animate = pulse && !reduce;
  // Touch pad centre.
  const cx = 124;
  const cy = 80;

  return (
    <svg viewBox="0 0 280 160" aria-hidden="true" className={cn("w-60", className)} fill="none">
      <defs>
        <linearGradient id={body} x1="0" y1="44" x2="0" y2="116" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#24262e" />
          <stop offset="1" stopColor="#15161b" />
        </linearGradient>
        <linearGradient id={plug} x1="0" y1="62" x2="0" y2="98" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#5b5f6b" />
          <stop offset="1" stopColor="#2f3138" />
        </linearGradient>
        <radialGradient id={pad} cx={cx} cy={cy - 6} r="26" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3a3f7a" />
          <stop offset="1" stopColor="#1c1e36" />
        </radialGradient>
        <radialGradient id={shadow} cx="140" cy="132" r="110" gradientTransform="matrix(1 0 0 0.12 0 116)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#000000" stopOpacity="0.55" />
          <stop offset="1" stopColor="#000000" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Soft floor shadow. */}
      <ellipse cx="140" cy="132" rx="110" ry="13" fill={`url(#${shadow})`} />

      {/* Rings from the touch pad (drawn first: the body covers their inner part). */}
      {animate ? (
        [0, 1].map((ring) => (
          <motion.circle
            key={ring}
            cx={cx}
            cy={cy}
            stroke="#8b93ff"
            strokeWidth="1.5"
            initial={{ r: 24, opacity: 0 }}
            animate={{ r: [24, 62], opacity: [0.55, 0] }}
            transition={{ duration: 2.6, ease: "easeOut", repeat: Infinity, delay: ring * 1.3 }}
          />
        ))
      ) : (
        <circle cx={cx} cy={cy} r="40" stroke="#8b93ff" strokeOpacity="0.22" strokeWidth="1.5" />
      )}

      {/* USB-C plug. */}
      <rect x="214" y="64" width="34" height="32" rx="7" fill={`url(#${plug})`} />
      <rect x="214.75" y="64.75" width="32.5" height="30.5" rx="6.25" stroke="#ffffff" strokeOpacity="0.08" strokeWidth="1.5" />
      <rect x="224" y="74" width="18" height="12" rx="4" fill="#121317" />

      {/* Body. */}
      <rect x="32" y="44" width="190" height="72" rx="24" fill={`url(#${body})`} />
      <rect x="32.75" y="44.75" width="188.5" height="70.5" rx="23.25" stroke="#3a3d46" strokeWidth="1.5" />
      <path d="M 58 46.5 H 196" stroke="#ffffff" strokeOpacity="0.07" strokeWidth="1.5" strokeLinecap="round" />

      {/* Key-ring hole. */}
      <circle cx="60" cy="80" r="10" fill="#0c0d10" />
      <circle cx="60" cy="80" r="10" stroke="#3a3d46" strokeWidth="1.5" />

      {/* Touch pad. */}
      <circle cx={cx} cy={cy} r="24" fill={`url(#${pad})`} />
      <circle cx={cx} cy={cy} r="24" stroke="#8b93ff" strokeOpacity="0.75" strokeWidth="1.5" />
      <circle cx={cx} cy={cy} r="15" stroke="#a7adff" strokeOpacity="0.3" strokeWidth="1.25" />
      <circle cx={cx} cy={cy} r="6" fill="#a7adff" fillOpacity="0.9" />

      {/* Status light. */}
      {animate ? (
        <motion.circle
          cx="186"
          cy="80"
          r="3.5"
          fill="#a7adff"
          initial={{ opacity: 0.35 }}
          animate={{ opacity: [0.35, 1, 0.35] }}
          transition={{ duration: 1.3, ease: "easeInOut", repeat: Infinity }}
        />
      ) : (
        <circle cx="186" cy="80" r="3.5" fill="#a7adff" />
      )}
      <circle cx="186" cy="80" r="7" stroke="#a7adff" strokeOpacity="0.16" strokeWidth="1.5" />
    </svg>
  );
}
