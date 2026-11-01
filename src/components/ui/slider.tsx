import { Slider as SliderPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** Range slider (e.g. password length). Give it an `aria-label` or `aria-labelledby` via `thumbLabel`. */
export function Slider({
  className,
  thumbLabel,
  ...props
}: ComponentProps<typeof SliderPrimitive.Root> & { thumbLabel?: string }) {
  const count = (props.value ?? props.defaultValue ?? [0]).length;
  return (
    <SliderPrimitive.Root
      className={cn(
        "relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-line-strong">
        <SliderPrimitive.Range className="absolute h-full bg-accent" />
      </SliderPrimitive.Track>
      {Array.from({ length: count }, (_, i) => (
        <SliderPrimitive.Thumb
          key={i}
          aria-label={thumbLabel}
          className="block size-4 rounded-full border-2 border-accent bg-canvas shadow-soft transition-[background-color] duration-150 hover:bg-elevated"
        />
      ))}
    </SliderPrimitive.Root>
  );
}
