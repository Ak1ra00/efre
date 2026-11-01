import { Component, type ErrorInfo, type ReactNode } from "react";

import { EfreMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

interface State {
  failed: boolean;
}

/**
 * Last resort for a rendering bug: a calm screen instead of a blank window. Reloading
 * the webview is always safe (Rust holds the vault state; a locked vault stays locked).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Development only: component stacks never contain vault secrets, but keep release quiet.
    if (import.meta.env.DEV) console.error("efre: render error", error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="flex h-full items-center justify-center p-8">
        <div role="alert" className="flex max-w-sm flex-col items-center gap-4 text-center">
          <EfreMark className="size-10" />
          <div className="flex flex-col gap-1">
            <h1 className="text-base font-semibold">Something went wrong</h1>
            <p className="text-fg-muted">efre hit a display problem. Reloading fixes it; your vault is safe.</p>
          </div>
          <Button
            variant="primary"
            onClick={() => {
              window.location.reload();
            }}
          >
            Reload
          </Button>
        </div>
      </main>
    );
  }
}
