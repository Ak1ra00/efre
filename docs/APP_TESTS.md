# App tests (phase 4): the efre app on your PC with two YubiKeys

These tests use the real app and the real vault location,
`%LOCALAPPDATA%\efre\vault.efre`. Treat this vault as a **test vault**: don't put real
secrets in it until phase 5 is done.

> ⚠️ **Never test "PIN blocked" on a key you rely on.** Unblocking a FIDO PIN requires
> a FIDO reset, which wipes every FIDO credential on that key, including your passkeys.

**Start over at any point:**
1. Quit efre. Make sure no `efre.exe` is left in Task Manager.
2. Delete everything in `%LOCALAPPDATA%\efre` except the `webview` folder (that folder
   is harmless).
3. The old credentials stay on the keys. They are unused and do no harm.

## 1. Install
1. Open https://github.com/Ak1ra00/efre/actions, signed in to GitHub.
2. Click the newest **CI** run on branch `phase-4-app` that has a green tick.
3. Under **Artifacts**, download `efre-windows-unsigned-…` and unzip it.
4. Run `bundle\nsis\efre_0.1.0_x64-setup.exe`.
   - SmartScreen will warn, because the installer is unsigned until phase 5. Choose
     **More info → Run anyway**.
   - It installs for your user only. There should be **no administrator prompt**.
5. Start efre from the Start menu.

## 2. Checks
Tick each line. Write down anything that looks or feels wrong, even small things.

### First run (setup wizard)
- [ ] The window opens dark, with no white flash. The title bar is dark, and
      Windows 11 snap layouts appear when you hover over maximize.
- [ ] Welcome → "How efre works" → enroll primary key → enroll backup key → done.
- [ ] Each enrollment says which key to insert, then shows **two** Windows Security
      prompts on the same key: create it, then confirm it.
- [ ] Enrolling the same key twice shows a friendly "already enrolled" message.
- [ ] Cancelling a Windows prompt shows a friendly message and lets you retry.
- [ ] Finishing with only one key works, but a banner keeps warning you to add a
      backup key.
- [ ] The wizard ends unlocked, on an empty vault with a helpful empty state.

### Unlock
- [ ] Close efre and start it again. The unlock screen shows "Insert and touch your
      YubiKey", a key illustration and a pulse.
- [ ] Unlock with key 1, then lock (Ctrl+L), then unlock with key 2. Both work.
- [ ] Each of these shows friendly copy, and you can retry afterwards:
  - no key inserted;
  - cancel the prompt;
  - wrong PIN once;
  - a YubiKey that isn't enrolled. Windows usually reports this as cancelled, so the
    copy should cover "not recognised".

### Items
- [ ] Create one of each kind: Login, Secure Note (with some Markdown), Card,
      Identity, and Custom with every field kind (text, hidden, URL, email, phone,
      date, multiline).
- [ ] Hidden values show as dots.
- [ ] **Reveal** shows a value with a countdown, and it hides itself again after 10 s.
      It also hides at once when you switch to another window.
- [ ] Copy the password and the username, from the buttons, Ctrl+C and Ctrl+B. A toast
      says it's copied and when the clipboard clears.
- [ ] Edit an item, change one field, save, and reopen it. Untouched hidden fields
      keep their old values.
- [ ] Tags, favorites and sorting work.
- [ ] Trash an item, then click **Undo** in the toast: the item comes back.
- [ ] Trash an item, then restore it from Trash.
- [ ] Delete an item from Trash forever, and use **Empty trash** (it asks to confirm).
- [ ] Ctrl+F focuses search. Fuzzy matches work (typos, partial words) and feel
      instant.
- [ ] Ctrl+K opens the palette, and every action can be run from it.
- [ ] Ctrl+N opens the new-item menu (1–5 pick a kind), Esc goes back or closes, and
      `?` shows the shortcut sheet.
- [ ] Narrow the window: the panes collapse cleanly, and nothing is cut off.
- [ ] Everything can be done with the keyboard only (Tab, arrows, Enter, Esc), and the
      focus ring is always visible.

### Generator
- [ ] Generate passwords and passphrases. Change the length and the options.
- [ ] The strength label changes as expected: Weak, Fair, Strong, Very strong.
- [ ] Copy the result and paste it into Notepad: it matches what was shown.
- [ ] In the item editor, **Generate** on a password field, then **Use**: the field is
      filled. Save, reveal, and check it matches.

### Clipboard
- [ ] Copy a password and paste it within the timer: it works.
- [ ] Wait out the timer (30 s by default): pasting now gives nothing.
- [ ] Copy a password, then copy some other text yourself before the timer ends. Your
      text is **not** cleared.
- [ ] Win+V (clipboard history) never lists an efre secret.
- [ ] Copy a password, then lock (Ctrl+L): the clipboard is cleared at once.
- [ ] Copy a password, then quit efre: the clipboard is cleared at once.

### Auto-lock
Each of these locks the vault. The unlock screen then says why it locked.
- [ ] **Idle:** set auto-lock to 1 minute in Settings, then leave efre alone.
- [ ] **Windows lock:** press Win+L, then sign back in.
- [ ] **Sleep:** Start → Power → Sleep, then wake the PC.
- [ ] **Unplug:** with one key inserted, remove it. With both keys inserted, removing
      one does **not** lock; removing the second does.
- [ ] After any lock, the item list and any revealed value are gone. Nothing shows
      until you unlock again.

### Settings
- [ ] Changing the auto-lock and clipboard timers works, and they are still set after
      a restart.
- [ ] YubiKeys shows each key's nickname and enrolled date.
- [ ] Rename a key: one prompt.
- [ ] Add a key: three prompts (any enrolled key, then the new key twice). Use a third
      key if you have one; otherwise remove one first, as in the next test.
- [ ] **Remove a lost key** (with two keys enrolled):
  - it asks to confirm;
  - you then touch each remaining key once;
  - afterwards, the removed key can no longer unlock;
  - the remaining key still unlocks, and every item is intact.
- [ ] The single-key banner appears once only one key is left. Add the key back
      afterwards.
- [ ] "Open vault folder" opens `%LOCALAPPDATA%\efre` in Explorer.
- [ ] Security info shows the app version, the format version, the WebAuthn API
      version, protections and limits.

### Screenshot and browser lockdown
- [ ] Take a screenshot with Win+Shift+S, PrtScn, or the Snipping Tool screen
      recorder: the efre window comes out **black**. Check this on the setup, unlock
      and vault screens.
- [ ] Right-click anywhere: no browser context menu. A text field may still show a
      Cut/Copy/Paste menu.
- [ ] Ctrl+P, Ctrl+R, F5, F12, Ctrl+Shift+I, Ctrl+U, Ctrl+F (as a browser find bar)
      and Ctrl+plus/minus do nothing browser-like.
- [ ] Start a second copy of efre from the Start menu. The existing window comes to
      the front, and no second window opens.

### No network
With efre open and unlocked, run this in PowerShell. It watches efre and its
WebView2 processes for two minutes while you use the app; open items, search, and
lock and unlock during that time.
```powershell
$end = (Get-Date).AddMinutes(2); $seen = 0
while ((Get-Date) -lt $end) {
  $ids = @((Get-Process efre -ErrorAction SilentlyContinue).Id) +
         @((Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
            Where-Object { $_.CommandLine -like '*\efre\webview*' }).ProcessId)
  $tcp = Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess }
  $udp = Get-NetUDPEndpoint  -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess }
  if ($tcp -or $udp) { $seen++; $tcp; $udp }
  Start-Sleep 2
}
"processes watched: $($ids.Count)   samples with sockets: $seen"
```
- [ ] It ends with `samples with sockets: 0`, and `processes watched` is 2 or more.

## 3. Results to send back
- Any line you couldn't tick, with what you saw. Include the exact message text where
  there was one.
- The output of the "No network" script.
- Anything that felt slow, confusing or ugly.
