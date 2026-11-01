import { Tabs as TabsPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        "inline-flex items-center gap-1 rounded-lg border border-line bg-surface p-1",
        "data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch data-[orientation=vertical]:border-0 data-[orientation=vertical]:bg-transparent data-[orientation=vertical]:p-0",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "inline-flex h-7 items-center gap-2 rounded-md px-3 text-[13px] font-medium whitespace-nowrap text-fg-muted transition-colors duration-150 select-none",
        "hover:text-fg data-[state=active]:bg-selected data-[state=active]:text-fg data-[state=active]:shadow-highlight",
        "data-[orientation=vertical]:h-8 data-[orientation=vertical]:justify-start data-[orientation=vertical]:px-2.5",
        "disabled:pointer-events-none disabled:text-fg-disabled [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn("min-h-0 flex-1 focus-visible:outline-offset-0 data-[state=active]:animate-fade-in", className)}
      {...props}
    />
  );
}
