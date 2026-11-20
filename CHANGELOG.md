# Changelog

Every update gets a new version number. It shows in the installer's file name and in **Settings → About**.

## 1.7.0
- Purchases now use the **live** VELS Labs store: the Get buttons open real checkout pages (Family $5, Pro $15, Team $69, Business $199) and real keys unlock the plan. Keys from the old test store no longer work.
- Updated Electron to version 45 (version 39 no longer gets security fixes). The build no longer downloads Electron in a separate step.
- Security: the app checks its own files at startup and refuses to run if they were changed after the build (ASAR integrity check).
- Fixed (security): website description lookups could be tricked into contacting a PC on your home network by a site whose address changes between checks (DNS rebinding). The address is now checked again at the moment of connecting.
- Made by **VELS Labs**: shown in Settings → About, the installer and NOTICE.md.
- README: clearer privacy section (what is saved, and the only things that go over the internet).
- Fixed: the kid PC's history size could show 0 bytes for up to 30 seconds after the first page was saved.
- Fixed (build): the tests picked random network ports and could fail with "address already in use" when Windows had reserved one. They now let Windows choose free ports.
- Fixed: after the app stopped, a connection that was still being set up could finish and briefly reconnect. A stopped app now refuses to finish any connection.
- Build tools: the packager (electron-builder) is forced onto the fixed version of minimatch (11.0.1 or newer), clearing the 6 "moderate" npm audit warnings. This only affects building the app, not the app itself.
- Fixed: after **Lock now** in Settings → Main PC there was no way to unlock again from Settings. The row now shows **Unlock** while locked (it asks for the passcode).
- Updates and restarts never cost you your pairings:
  - A paired PC whose saved key can't be unlocked at start (for example while Windows is still starting up) is no longer deleted. It is kept, tried again 20 seconds later and at the next start.
  - This PC's ID, the list of paired PCs and the settings are re-read if a file is briefly locked (antivirus), and a backup copy (`.bak`) is kept and used if a file is damaged. A damaged file with no backup is set aside, never overwritten. Anything like this is noted in the security log.
  - New test: simulates updates and restarts with each of these problems.
- Plan limits stay the same (Free 3 · Family 6 · Pro 15 · Team 25 · Business 100 linked PCs).

## 1.6.0
- Family history: website names are links. Click one to open that exact page in your browser (asks first).
- Kids' PCs now save the address of each page visited (when "Include websites" is on), so each video or page gets its own line in the history.
- Copy buttons: copy one line, or **Copy day** for the whole day as plain text.
- Short descriptions of websites ("Video sharing site", "Free school lessons…"). Popular sites are built in; other sites are looked up once from their home page and remembered. Only public websites are contacted, never your home network. Turn it on or off in the history window or Settings → Parental controls.
- Manage history storage: the history window shows how much space it uses on the kid's PC and has **Delete history…**; on the kid's PC, Settings → Parental controls shows the size and **Open folder** (needs the main PC passcode).
- Tests: added website description and history storage checks.

## 1.5.3
- Purchases are connected to the Polar **test** store: the Get buttons open real checkout pages (Family $5, Pro $15, Team $69, Business $199) and keys bought there unlock the plan. No real money moves yet; switch to the live store before release (SELLING.md → Go live).

## 1.5.2
- New accent color: bright pink (Settings → Appearance).
- License keys with a prefix (like `VELS_…`) are accepted.
- Fixed (security): if a PC disconnected or was removed while its task was waiting for "Allow?", clicking Allow could still run the command. Requests from a PC that's gone are now cancelled, and their pop-ups close by themselves.
- Fixed: accepting files after the sending PC disconnected left them stuck as "queued".
- Fixed: an unexpected error from the store could switch a paid plan to Free and never check again. Now only a key the store says is gone or revoked counts; anything else uses the 30-day offline grace, and a revoked key is re-checked daily.
- Fixed: the accent color now applies right away when the app opens (no brief flash of blue).
- Fixed: opening the window from the tray could fail if Windows had already closed it.
- The transfer list in memory is capped, so PCs that send lots of files stay light.
- Tests: added a test for requests from a PC that disconnects.

## 1.5.1
- Every pop-up can be closed: a thin X in the corner (it spins while the mouse is on it), the Esc key, or clicking outside. Closing does the same as the pop-up's own Cancel, Decline or Deny, so nothing is left half-done. Requests from another PC (access, tasks, files) don't close on a stray click outside.
- The plain Windows confirm boxes are replaced with the app's own pop-ups (Remove access, Clear log, Remove license, opening a program someone sent).
- New button look: thin outlines, see-through on hover. The main button is outlined in blue; red ones for removing things.
- Small hover animations that act out what each button does: arrows nudge, the lock opens, the bin lid lifts, the play icon pops. They're turned off when Windows is set to reduce animations.
- Buttons press in slightly when clicked.

## 1.5.0
- New plans: **Family** (between Free and Pro) and **Team** (small offices, allowed for business use). Five plans now: Free, Family, Pro, Team, Business.
- New limit: **linked PCs**, meaning how many other PCs this one can pair with (Free 3, Family 6, Pro 15, Team 25, Business 100). Your own PC doesn't count, so a main PC plus 3 kids' PCs fits Free.
- A full PC refuses new access requests with the reason, and can't send new requests either. PCs that are already linked are never cut off after a downgrade.
- Connections shows "X of Y PCs" with an upgrade link when full.
- File-size messages suggest the next plan up instead of always Pro.
- Plan details are built from the real limits, so the text always matches. Team and Business remind businesses to tell staff when the Family page is used on work PCs.
- Store setup (`store.js`, `SELLING.md`) now has entries for all four paid plans.

## 1.4.1
- Fixed: the Settings and Files pages could be blank (and the window stop responding) after the plans update.
- Fixed: file transfers could freeze when the receiving PC's disk was slower than the network (common with antivirus on Windows). New-file locks from antivirus are retried, and a transfer that's never confirmed now fails after 2 minutes instead of hanging.
- New: the Transfers list keeps its history between restarts (last 300, on that PC only).
- New: **Open** and **Show in folder** for finished transfers, for both the sender and the receiver. Received programs and scripts ask before opening.
- New: click a plan for its details. **Get Pro** / **Get Business** buttons are always visible and explain when purchases aren't set up yet.
- Changed: the Output panel uses a simple terminal icon instead of macOS-style colored dots.
- Tests: added a slow-disk transfer test and a check that every page's data exists.

## 1.4.0
- Plans: Free, Pro and Business, with one-time license keys sold through Polar and one purchase per household.
- Limits: kid PCs in Family (3 / 15 / 100) and file size per transfer (1 GB / 20 GB / any).
- Source-available license (PolyForm Noncommercial), with `SELLING.md` and `NOTICE.md`.

## 1.3.0
- Main (parent) PC chosen on the first connection, with a 4- or 6-digit passcode checked by the main PC.

## 1.2.0
- Parental controls: Discord-style live status of games and websites, plus a daily history.

## 1.1.0
- Linux support, per-PC permissions, Security page and log, encrypted key storage, and GitHub-ready setup.

## 1.0.0
- First version: office board, PIN pairing, tasks, file sharing and live stats.
