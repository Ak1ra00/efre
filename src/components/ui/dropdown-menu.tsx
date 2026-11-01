import { Check, ChevronRight, Circle } from "lucide-react";
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { KbdCombo } from "./kbd";

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;
export const DropdownMenuPortal = MenuPrimitive.Portal;
export const DropdownMenuSub = MenuPrimitive.Sub;
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

/** Popover surface shared by menus, selects and popovers. */
export const popoverSurfaceClass = cn(
  "z-50 overflow-hidden rounded-lg border border-line bg-elevated text-fg shadow-popover",
  "data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in",
);

const itemClass = cn(
  "relative flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-none select-none",
  "data-highlighted:bg-hover data-highlighted:text-fg data-disabled:pointer-events-none data-disabled:text-fg-disabled",
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-fg-subtle",
);

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          popoverSurfaceClass,
          "max-h-(--radix-dropdown-menu-content-available-height) min-w-44 origin-(--radix-dropdown-menu-content-transform-origin) overflow-y-auto p-1",
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

interface DropdownMenuItemProps extends ComponentProps<typeof MenuPrimitive.Item> {
  /** "danger" for destructive items (red text). */
  variant?: "default" | "danger";
  inset?: boolean;
}

export function DropdownMenuItem({ className, variant = "default", inset, ...props }: DropdownMenuItemProps) {
  return (
    <MenuPrimitive.Item
      className={cn(
        itemClass,
        inset === true && "pl-8",
        variant === "danger" &&
          "text-danger-text data-highlighted:bg-danger-soft data-highlighted:text-danger-text [&_svg:not([class*='text-'])]:text-danger-text",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem className={cn(itemClass, "pl-8", className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <Check className="size-4 text-accent-text" aria-hidden="true" />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cn(itemClass, "pl-8", className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <Circle className="size-2 fill-current text-accent-text" aria-hidden="true" />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

export function DropdownMenuLabel({
  className,
  inset,
  ...props
}: ComponentProps<typeof MenuPrimitive.Label> & { inset?: boolean }) {
  return (
    <MenuPrimitive.Label
      className={cn("px-2 pt-2 pb-1 text-xs font-medium text-fg-subtle", inset === true && "pl-8", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-line", className)} {...props} />;
}

/** Right-aligned shortcut hint inside an item, e.g. `<DropdownMenuShortcut combo="Ctrl+C" />`. */
export function DropdownMenuShortcut({ combo, className }: { combo: string; className?: string }) {
  return <KbdCombo combo={combo} className={cn("ml-auto", className)} />;
}

export function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.SubTrigger> & { inset?: boolean }) {
  return (
    <MenuPrimitive.SubTrigger
      className={cn(itemClass, "data-[state=open]:bg-hover", inset === true && "pl-8", className)}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto size-4" aria-hidden="true" />
    </MenuPrimitive.SubTrigger>
  );
}

export function DropdownMenuSubContent({ className, ...props }: ComponentProps<typeof MenuPrimitive.SubContent>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.SubContent
        className={cn(
          popoverSurfaceClass,
          "min-w-40 origin-(--radix-dropdown-menu-content-transform-origin) p-1",
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}
