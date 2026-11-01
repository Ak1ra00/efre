import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** Placeholder block while something loads. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div aria-hidden="true" className={cn("rounded-md bg-hover", className)} {...props} />;
}
