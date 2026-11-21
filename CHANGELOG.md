# Changelog

Every update gets a new version number. It shows in the installer's file name and in **Settings → About**.

## 1.9.0
- **New: NAS (Pro, Team and Business).** One shared folder for the whole home, kept on one PC.
  - **NAS → Use this PC as the NAS**, then choose a folder (for example `D:\Family Files`). Switches: recycle bin (30 days), keep this PC awake, ask before new devices can use it.
  - Every paired PC sees it in its **NAS** tab: browse folders, search, **Upload** or drag files in, **New folder**, rename, delete, and **Get** to download a copy.
  - Access per PC: **Full**, **View only** or **No access**, asked the first time a PC opens the NAS and changeable in **NAS settings**. On family setups the main PC decides.
  - A **Kids** folder: kids' PCs see only that folder and can use it without asking. Any other PC can also be limited to it.
  - Deleting goes to the NAS recycle bin for 30 days (or to the NAS PC's Recycle Bin if the bin is off). Restore or empty it from **Recycle bin**.
  - Move the NAS to another folder or another PC, with **Copy everything over** or **Start empty**. The old folder is never deleted.
  - Phones connected to the NAS PC get a **NAS** tab: browse, **Save to NAS** and **Get**.
  - Free and Family show a preview with an upgrade button. Files never go through the internet.
- **New: File history.** In **Office**, open a PC and press **File history** to see everything that PC sent or received, with any PC or phone.
  - Filters (sent/received, 7 or 30 days), search, and multi-select.
  - **Open** or **Show** files that are also on this PC, **Get a copy** from that PC, **Send again** to another PC or phone, and **Delete on that PC** (it goes to that PC's Recycle Bin, and that PC shows a note).
  - On normal setups anyone can open it. On family setups (with a main PC) it needs the main PC passcode.
  - "Get a copy" follows that PC's **Send files** setting (Allow / Ask / Never). Deleting always asks that PC, only works on files it received (never its own originals), and is written in its security log.
- **New: tab names.** **Settings → Appearance → Tab names** renames the sidebar tabs and the phone page tabs (Send, Get, NAS) on each PC, with a reset button per tab and **Reset all to default**. On family setups a kid's PC asks the main PC to approve new names.
- New tests: file history (permissions, passcode, Recycle Bin, re-send), tab names (kid approval) and the NAS (access levels, Kids folder, recycle bin, moving, phones).

## 1.8.0
- **New: phones and tablets.** Send photos, videos, music and any file between your PCs and an iPhone, iPad or Android device, with nothing to install on the phone.
  - **Files → Connect phone or tablet** shows a QR code. Scan it with the phone's camera, then click **Allow** on the PC and name the phone.
  - The phone page has **Send to PC** (photo library or any file) and **Get from PC** (files you drop on the phone in the Files tab). Phone to phone works through the PC.
  - Phones show up in **Send to** with a phone icon, and in **Connections → Phones & tablets** (rename, remove).
  - Step-by-step help pop-ups on the phone: saving to Photos on iPhone, where downloads go, sending several files, and adding VELS to the Home Screen. Each can be hidden with "Don't show this again" and reopened with **?**.
  - Big transfers continue where they left off if the connection drops.
- **Security for phones:**
  - The page only answers on your home network.
  - Everything is encrypted (TweetNaCl).
  - Codes work once and expire after 2 minutes. The phone gets its own key after approval, stored encrypted on the PC.
  - Replayed or tampered requests are refused, and repeated bad requests block that address.
  - The phone server is off unless a phone is connected or a code is on screen.
- The firewall button now also opens the phone port (47822) to your local network.
- Phones don't count toward the plan's PC limit. The plan's file size limit applies.
- New test: phone pairing, upload, resume, download, phone-to-phone, restart and refusing strangers.
- New installs start with the **Green** accent color (was Blue). If you already picked a color, it stays as you set it.
- **Phone QR** in the sidebar (under Settings) opens the QR code in one click. A phone that's already connected can scan it just to open VELS: no new Allow, and the PC's QR window closes by itself.
- The phone page matches the PC's accent color (it switches within a few seconds when you change it) and follows the phone's own Light/Dark Mode.
- Phones fixes found in testing:
  - The PC now shows "Page closed" by itself when a phone closes its VELS page.
  - On iPhone, the Home Screen icon opens in Safari so it stays connected (Home Screen web apps get separate storage).
  - A phone that reconnects with the same name replaces its old entry instead of being listed twice, and files waiting for it move over.
  - If another program uses the phone port, the next free one is used and remembered.
  - The QR code prefers the real Wi-Fi/Ethernet address over virtual adapters (WSL, Hyper-V, VPNs).

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
