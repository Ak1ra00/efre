/**
 * Settings (SPEC §6): YubiKeys, timers, the vault file and security info. Mounted
 * globally while unlocked; `openSettings(section)` opens it at a section. Sections sit
 * in a sidebar on wide windows and in a tab row on narrow ones.
 */
import { HardDrive, KeyRound, type LucideIcon, ShieldCheck, Timer } from "lucide-react";

import { type SettingsSection, SETTINGS_SECTIONS, useUIState } from "@/app/ui-state";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { ESC_CANCELS_SELECTOR, KeysSection } from "./KeysSection";
import { SecuritySection } from "./SecuritySection";
import { TimersSection } from "./TimersSection";
import { useMediaQuery } from "./use-media-query";
import { VaultSection } from "./VaultSection";

const SECTIONS: Record<SettingsSection, { label: string; icon: LucideIcon }> = {
  keys: { label: "YubiKeys", icon: KeyRound },
  timers: { label: "Auto-lock & clipboard", icon: Timer },
  vault: { label: "Vault file", icon: HardDrive },
  security: { label: "Security", icon: ShieldCheck },
};

function isSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

export function SettingsDialog() {
  const { settingsOpen, settingsSection, setSettingsSection, closeSettings } = useUIState();
  const wide = useMediaQuery("(min-width: 640px)");
  return (
    <Dialog
      open={settingsOpen}
      onOpenChange={(open) => {
        if (!open) closeSettings();
      }}
    >
      <DialogContent
        size="xl"
        className="h-[min(680px,calc(100dvh-4rem))] max-w-3xl overflow-hidden"
        onEscapeKeyDown={(event) => {
          // Inside an inline edit (rename, add key), Esc cancels the edit, not Settings.
          if (event.target instanceof Element && event.target.closest(ESC_CANCELS_SELECTOR) !== null) {
            event.preventDefault();
          }
        }}
      >
        <Tabs
          value={settingsSection}
          onValueChange={(value) => {
            if (isSection(value)) setSettingsSection(value);
          }}
          orientation={wide ? "vertical" : "horizontal"}
          className="flex min-h-0 flex-1 flex-col sm:flex-row"
        >
          <div className="flex shrink-0 flex-col gap-4 border-b border-line px-4 pt-5 pb-3 sm:w-56 sm:border-r sm:border-b-0 sm:bg-surface/40 sm:px-3 sm:pb-4">
            <div className="flex flex-col gap-0.5 px-2 pr-10 sm:pr-2">
              <DialogTitle>Settings</DialogTitle>
              <DialogDescription className="text-[13px]">Keys, timers and your vault file.</DialogDescription>
            </div>
            <TabsList
              aria-label="Settings sections"
              className="flex-wrap justify-start border-0 bg-transparent p-0 sm:flex-nowrap"
            >
              {SETTINGS_SECTIONS.map((section) => {
                const { label, icon: Icon } = SECTIONS[section];
                return (
                  <TabsTrigger key={section} value={section} className="data-[orientation=vertical]:w-full">
                    <Icon aria-hidden="true" />
                    {label}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <TabsContent value="keys" className="p-6">
              <KeysSection />
            </TabsContent>
            <TabsContent value="timers" className="p-6">
              <TimersSection />
            </TabsContent>
            <TabsContent value="vault" className="p-6">
              <VaultSection />
            </TabsContent>
            <TabsContent value="security" className="p-6">
              <SecuritySection />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
