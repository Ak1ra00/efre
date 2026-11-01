import { CircleAlert, CircleCheck, X } from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

import { buttonVariants } from "./button";
import { dismissToast, type ToastRecord, useToast } from "./use-toast";

const icons = {
  default: null,
  success: <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success-text" />,
  danger: <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger-text" />,
} as const;

function ToastItem({ toast }: { toast: ToastRecord }) {
  const variant = toast.variant ?? "default";
  return (
    <ToastPrimitive.Root
      open={toast.open}
      onOpenChange={(open) => {
        if (!open) dismissToast(toast.id);
      }}
      duration={toast.duration ?? (toast.action ? 8000 : 5000)}
      // Errors interrupt the screen reader; everything else is polite.
      type={variant === "danger" ? "foreground" : "background"}
      className={cn(
        "group pointer-events-auto relative flex w-full items-start gap-3 rounded-lg border border-line-strong bg-elevated py-3 pr-10 pl-3.5 shadow-popover",
        "data-[state=closed]:animate-toast-out data-[state=open]:animate-toast-in",
        "data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-[translate] data-[swipe=end]:animate-toast-out data-[swipe=move]:translate-x-(--radix-toast-swipe-move-x)",
      )}
    >
      {icons[variant]}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <ToastPrimitive.Title className="text-sm font-medium text-fg">{toast.title}</ToastPrimitive.Title>
        {toast.description === undefined ? null : (
          <ToastPrimitive.Description className="text-[13px] text-fg-muted">{toast.description}</ToastPrimitive.Description>
        )}
      </div>
      {toast.action === undefined ? null : (
        <ToastPrimitive.Action
          altText={toast.action.altText ?? toast.action.label}
          onClick={toast.action.onClick}
          className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "self-center")}
        >
          {toast.action.label}
        </ToastPrimitive.Action>
      )}
      <ToastPrimitive.Close
        aria-label="Dismiss"
        className="absolute top-2.5 right-2.5 inline-flex size-6 items-center justify-center rounded-md text-fg-subtle transition-colors duration-150 hover:bg-hover hover:text-fg"
      >
        <X aria-hidden="true" className="size-3.5" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}

/** Mounted once by the app shell. F8 focuses the toasts (Radix default). */
export function Toaster() {
  const { toasts } = useToast();
  return (
    <ToastPrimitive.Provider swipeDirection="right" label="Notification">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
      <ToastPrimitive.Viewport className="fixed right-0 bottom-0 z-[100] m-0 flex w-full max-w-sm list-none flex-col gap-2 p-4 outline-none" />
    </ToastPrimitive.Provider>
  );
}
