/**
 * PLACEHOLDER (E0). Owned by E3: replace freely, keep this path and export name.
 * Mounted globally while unlocked; open state comes from useUIState()
 * (settingsOpen / settingsSection / setSettingsSection / closeSettings).
 */
import { type SettingsSection, SETTINGS_SECTIONS, useUIState } from "@/app/ui-state";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const LABELS: Record<SettingsSection, string> = {
  keys: "YubiKeys",
  timers: "Auto-lock & clipboard",
  vault: "Vault file",
  security: "Security",
};

function isSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

export function SettingsDialog() {
  const { settingsOpen, settingsSection, setSettingsSection, closeSettings } = useUIState();
  return (
    <Dialog
      open={settingsOpen}
      onOpenChange={(open) => {
        if (!open) closeSettings();
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Keys, timers and the vault file.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Tabs
            value={settingsSection}
            onValueChange={(value) => {
              if (isSection(value)) setSettingsSection(value);
            }}
          >
            <TabsList>
              {SETTINGS_SECTIONS.map((section) => (
                <TabsTrigger key={section} value={section}>
                  {LABELS[section]}
                </TabsTrigger>
              ))}
            </TabsList>
            {SETTINGS_SECTIONS.map((section) => (
              <TabsContent key={section} value={section} className="pt-4 text-fg-muted">
                {LABELS[section]}: coming in phase 4.
              </TabsContent>
            ))}
          </Tabs>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
