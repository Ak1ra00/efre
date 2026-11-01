/**
 * DEV ONLY (`npm run dev:mock`, then open `/?gallery`): every UI primitive on one page,
 * for visual review and screenshots. Not part of any production build.
 */
import { Copy, KeyRound, MoreHorizontal, Plus, Search, Star, Trash2 } from "lucide-react";
import { MotionConfig } from "motion/react";
import { type ReactNode, useState } from "react";

import { EfreMark } from "@/components/brand/logo";
import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd, KbdCombo } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/toast";
import { Tip, TooltipProvider } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/use-toast";
import { AUTO_LOCK_PRESETS, formatMinutes } from "@/lib/defaults";
import { ITEM_KIND_ORDER, ITEM_KINDS } from "@/lib/items";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-medium tracking-wide text-fg-subtle uppercase">{title}</h2>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </section>
  );
}

export function Gallery() {
  const [length, setLength] = useState([20]);
  const [nickname, setNickname] = useState("");
  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <ScrollArea className="h-full" tabIndex={-1}>
          <main className="mx-auto flex max-w-4xl flex-col gap-8 p-8">
            <header className="flex items-center gap-3">
              <EfreMark className="size-9" />
              <div>
                <h1 className="text-lg font-semibold tracking-tight">efre UI kit</h1>
                <p className="text-fg-muted">src/components/ui · dev preview only</p>
              </div>
            </header>

            <Section title="Buttons">
              <Button variant="primary">Unlock</Button>
              <Button>
                <Plus aria-hidden="true" /> New item
              </Button>
              <Button variant="ghost">Cancel</Button>
              <Button variant="danger">
                <Trash2 aria-hidden="true" /> Delete forever
              </Button>
              <Button variant="link">Learn more</Button>
              <Button loading>Waiting for your YubiKey…</Button>
              <Button disabled>Disabled</Button>
              <Button size="sm">Small</Button>
              <Button variant="primary" size="lg">
                Large primary
              </Button>
              <Tip label="Copy password" shortcut="Ctrl+C">
                <Button size="icon" variant="ghost" aria-label="Copy password">
                  <Copy aria-hidden="true" />
                </Button>
              </Tip>
              <Tip label="Favorite">
                <Button size="icon-sm" variant="ghost" aria-label="Favorite">
                  <Star aria-hidden="true" />
                </Button>
              </Tip>
            </Section>

            <Section title="Inputs">
              <div className="grid w-full grid-cols-2 gap-4">
                <Field label="Nickname" hint="Shown on the unlock screen.">
                  {(p) => (
                    <Input
                      {...p}
                      value={nickname}
                      placeholder="e.g. Backup key"
                      onChange={(e) => {
                        setNickname(e.target.value);
                      }}
                    />
                  )}
                </Field>
                <Field label="Title" error="A title is required.">
                  {(p) => <Input {...p} defaultValue="" placeholder="Untitled" />}
                </Field>
                <Field label="Notes">{(p) => <Textarea {...p} placeholder="Markdown supported" rows={3} />}</Field>
                <div className="flex flex-col gap-4">
                  <Field label="Auto-lock">
                    {(p) => (
                      <Select defaultValue="5">
                        <SelectTrigger id={p.id} aria-describedby={p["aria-describedby"]}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {AUTO_LOCK_PRESETS.map((m) => (
                            <SelectItem key={m} value={String(m)}>
                              {formatMinutes(m)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </Field>
                  <div className="relative">
                    <Search aria-hidden="true" className="pointer-events-none absolute top-2 left-2.5 size-4 text-fg-subtle" />
                    <Input aria-label="Search" placeholder="Search" className="pl-8" />
                  </div>
                </div>
              </div>
            </Section>

            <Section title="Toggles">
              <div className="flex items-center gap-2">
                <Switch id="g-switch" defaultChecked />
                <Label htmlFor="g-switch">Symbols</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="g-switch2" />
                <Label htmlFor="g-switch2">Avoid ambiguous</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="g-check" defaultChecked />
                <Label htmlFor="g-check">Capitalize</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="g-check2" />
                <Label htmlFor="g-check2">Include a number</Label>
              </div>
              <div className="flex w-64 flex-col gap-2">
                <Label>Length: {length[0]}</Label>
                <Slider value={length} onValueChange={setLength} min={8} max={128} thumbLabel="Password length" />
              </div>
            </Section>

            <Section title="Badges and keys">
              <Badge>work</Badge>
              <Badge variant="accent">Very strong</Badge>
              <Badge variant="success">Copied</Badge>
              <Badge variant="warning">1 key</Badge>
              <Badge variant="danger">Trash</Badge>
              <Badge variant="outline">12</Badge>
              <Kbd>Esc</Kbd>
              <KbdCombo combo="Ctrl+K" />
              <KbdCombo combo="Ctrl+Shift+P" />
              <KbdCombo combo="?" />
              <Spinner label="Loading" />
            </Section>

            <Section title="Item kinds">
              {ITEM_KIND_ORDER.map((kind) => {
                const Icon = ITEM_KINDS[kind].icon;
                return (
                  <span key={kind} className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5">
                    <Icon aria-hidden="true" className="size-4 text-accent-text" /> {ITEM_KINDS[kind].label}
                  </span>
                );
              })}
            </Section>

            <Section title="Alerts">
              <Alert
                variant="warning"
                title="Only one YubiKey can open this vault."
                action={<Button size="sm">Add backup key</Button>}
                className="w-full"
              >
                If it's lost, nothing can open the vault.
              </Alert>
              <Alert variant="danger" title="PIN blocked" className="w-full">
                This key's PIN is blocked. Use your backup key, then remove this one in Settings.
              </Alert>
              <Alert title="Copies made before now can still be opened with the removed key." className="w-full" />
            </Section>

            <Section title="Overlays">
              <Dialog>
                <DialogTrigger asChild>
                  <Button>Dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Rename key</DialogTitle>
                    <DialogDescription>Confirm with any enrolled YubiKey.</DialogDescription>
                  </DialogHeader>
                  <DialogBody>
                    <Field label="Nickname">{(p) => <Input {...p} defaultValue="YubiKey 5C NFC" />}</Field>
                  </DialogBody>
                  <DialogFooter>
                    <Button variant="ghost">Cancel</Button>
                    <Button variant="primary">Rename</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="danger">Alert dialog</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Empty the trash?</AlertDialogTitle>
                    <AlertDialogDescription>2 items will be deleted for good. This can't be undone.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction>Empty trash</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button aria-label="Item actions">
                    <MoreHorizontal aria-hidden="true" /> Menu
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel>GitHub</DropdownMenuLabel>
                  <DropdownMenuItem>
                    <Copy aria-hidden="true" /> Copy password
                    <DropdownMenuShortcut combo="Ctrl+C" />
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <KeyRound aria-hidden="true" /> Copy username
                    <DropdownMenuShortcut combo="Ctrl+B" />
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Star aria-hidden="true" /> Favorite
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="danger">
                    <Trash2 aria-hidden="true" /> Move to trash
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Popover>
                <PopoverTrigger asChild>
                  <Button>Popover</Button>
                </PopoverTrigger>
                <PopoverContent>
                  <p className="text-fg-muted">Tags help you group items.</p>
                </PopoverContent>
              </Popover>
              <Button
                onClick={() => {
                  toast({
                    title: "Moved to trash",
                    description: "GitHub",
                    action: {
                      label: "Undo",
                      onClick: () => toast({ variant: "success", title: "Restored" }),
                    },
                  });
                }}
              >
                Toast with Undo
              </Button>
              <Button
                onClick={() => {
                  toast({ variant: "success", title: "Copied password", description: "Clears in 30 s." });
                }}
              >
                Success toast
              </Button>
              <Button
                onClick={() => {
                  toast({ variant: "danger", title: "No YubiKey found", description: "Plug it in, then try again." });
                }}
              >
                Error toast
              </Button>
            </Section>

            <Section title="Tabs">
              <Tabs defaultValue="password" className="w-full">
                <TabsList>
                  <TabsTrigger value="password">Password</TabsTrigger>
                  <TabsTrigger value="passphrase">Passphrase</TabsTrigger>
                </TabsList>
                <TabsContent value="password" className="pt-3 text-fg-muted">
                  20 characters, all four classes.
                </TabsContent>
                <TabsContent value="passphrase" className="pt-3 text-fg-muted">
                  6 words from the EFF long list.
                </TabsContent>
              </Tabs>
            </Section>

            <Section title="Surfaces">
              <div className="flex w-full gap-3">
                <div className="flex-1 rounded-xl border border-line bg-surface p-4">
                  <EmptyState
                    icon={Search}
                    title="No matches"
                    description="Try another search, or clear the filter."
                    action={<Button size="sm">Clear search</Button>}
                    className="py-6"
                  />
                </div>
                <div className="flex flex-1 flex-col gap-2 rounded-xl border border-line bg-surface p-4">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-2/3" />
                  <Separator className="my-2" />
                  <p className="text-fg-subtle">Skeleton and separator</p>
                </div>
              </div>
            </Section>
          </main>
        </ScrollArea>
        <Toaster />
      </TooltipProvider>
    </MotionConfig>
  );
}
