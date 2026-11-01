/**
 * App shell: providers and the phase state machine driven by `app_status`
 *   loading → unsupported | setup | locked | unlocked
 * Each phase screen (and all its state) is mounted fresh: the UI-state provider and the
 * command registry are keyed by phase, so locking drops everything at once.
 */
import { MotionConfig, motion } from "motion/react";
import type { ReactNode } from "react";

import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GeneratorDialog } from "@/generator/GeneratorDialog";
import { CommandPalette } from "@/palette/CommandPalette";
import { SettingsDialog } from "@/settings/SettingsDialog";
import { SetupWizard } from "@/setup/SetupWizard";
import { UnlockScreen } from "@/unlock/UnlockScreen";
import { UnsupportedScreen } from "@/unlock/UnsupportedScreen";
import { VaultScreen } from "@/vault/VaultScreen";

import { useActivityPinger } from "./activity";
import { AppStatusProvider, type Phase, useAppStatus } from "./app-status";
import { CommandRegistryProvider } from "./commands";
import { ErrorBoundary } from "./ErrorBoundary";
import { useBrowserGuards } from "./guards";
import { LoadingScreen, StartupError } from "./LoadingScreen";
import { useShellCommands } from "./shell-commands";
import { ShortcutSheet } from "./ShortcutSheet";
import { SingleKeyBanner } from "./SingleKeyBanner";
import { UIStateProvider } from "./ui-state";

export function App() {
  useBrowserGuards();
  return (
    <ErrorBoundary>
      <MotionConfig reducedMotion="user">
        <TooltipProvider>
          <AppStatusProvider>
            <PhaseRouter />
          </AppStatusProvider>
          <Toaster />
        </TooltipProvider>
      </MotionConfig>
    </ErrorBoundary>
  );
}

function PhaseRouter() {
  const { phase, error } = useAppStatus();
  return (
    <UIStateProvider key={phase}>
      <CommandRegistryProvider>
        <PhaseScreen phase={phase} startupFailed={error !== null} />
      </CommandRegistryProvider>
    </UIStateProvider>
  );
}

function PhaseScreen({ phase, startupFailed }: { phase: Phase; startupFailed: boolean }) {
  switch (phase) {
    case "loading":
      return startupFailed ? <StartupError /> : <LoadingScreen />;
    case "unsupported":
      return (
        <FadeIn>
          <UnsupportedScreen />
        </FadeIn>
      );
    case "setup":
      return (
        <FadeIn>
          <SetupWizard />
        </FadeIn>
      );
    case "locked":
      return (
        <FadeIn>
          <UnlockScreen />
        </FadeIn>
      );
    case "unlocked":
      return <UnlockedShell />;
  }
}

/** Screens fade in; they never fade out (on lock, content must vanish at once). */
function FadeIn({ children }: { children: ReactNode }) {
  return (
    <motion.div
      className="h-full"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}

function UnlockedShell() {
  useActivityPinger(true);
  useShellCommands();
  return (
    <FadeIn>
      <div className="flex h-full flex-col">
        <SingleKeyBanner />
        <div className="min-h-0 flex-1">
          <VaultScreen />
        </div>
      </div>
      <SettingsDialog />
      <CommandPalette />
      <GeneratorDialog />
      <ShortcutSheet />
    </FadeIn>
  );
}
