/** Phase 1 placeholder. The real UI (wizard, unlock, items) arrives in phase 4. */
export function App() {
  return (
    <main className="flex h-full items-center justify-center p-8">
      <div className="flex max-w-md flex-col gap-3 rounded-xl border border-border bg-surface p-8 shadow-lg">
        <h1 className="text-2xl font-semibold tracking-tight">efre</h1>
        <p className="text-sm text-muted">
          Scaffold build. The vault, YubiKey unlock and UI arrive in later phases.
        </p>
      </div>
    </main>
  );
}
