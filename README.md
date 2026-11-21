# VELS Syndicate

Link the computers on your home network. See what each one is doing, run tasks on them, and send files between them, all from one window. Works on **Windows 10/11** and **Linux**.

## Features

- **Office board.** Every computer gets a desk showing its status (Idle, Waiting, Working, Busy, Offline), its role, live CPU/RAM/GPU use, and what it is working on.
- **Tasks.** Run PowerShell, Command Prompt or Bash commands on any paired computer and watch the output live. You can save presets, stop tasks, and queue them.
- **Files.** Drag files or folders onto a computer to send them. Every file is checked when it arrives.
- **NAS (Pro and up).** Turn one PC into home storage: a shared folder every PC and phone can browse, save to and download from, with per-device access, a Kids folder and a 30-day recycle bin.
- **File history.** See everything a PC sent or received and open, re-send, copy back or delete those files.
- **Your own tab names.** Rename the sidebar and phone-page tabs on each PC.
- **Main PC and parental controls (Windows). One PC is the main (parent) PC with a 4- or 6-digit passcode. A kid's PC can share its activity with it. The parent sees a Discord-style live status (what's being played, including the game mode where the game shows it, or which website is open) and a daily history with screen time, top games, apps and sites, and a timeline. The kid's PC always shows that it is being shared. Turning it off, removing the main PC or quitting the app needs the main PC's passcode.
- **Secure by default.** You connect a computer by typing a PIN shown on the other screen. Each computer gets its own permissions, all traffic is encrypted, and a security log records activity (see below).
- **Glass interface.** On Windows 11 your desktop shows through the window, blurred. Windows 10 and Linux get a frosted look painted by the app.

## Plans

| | Free | Family | Pro | Team | Business |
|---|---|---|---|---|---|
| Connect PCs, run tasks, share files | ✓ | ✓ | ✓ | ✓ | ✓ |
| Other PCs you can link (incl. kids' PCs) | 3 | 6 | 15 | 25 | 100 |
| File size per transfer | 1 GB | 5 GB | 20 GB | 100 GB | any size |
| Home NAS | — | — | ✓ | ✓ | ✓ |
| Use in a business | — | — | — | ✓ | ✓ |

Paid plans are one-time purchases. The license key is entered once on the main PC and covers every PC connected to it. Activating needs the internet once, and then everything works offline. See [SELLING.md](SELLING.md) for how the store is set up.

## Install

| System | File | How |
|---|---|---|
| Windows (no install) | `VELS-Syndicate-Portable-<version>.exe` | Double-click it. |
| Windows (installer) | `VELS-Syndicate-Setup-<version>.exe` | Double-click it. Adds Desktop and Start menu shortcuts. |
| Linux (Debian/Ubuntu) | `VELS-Syndicate-<version>.deb` | `sudo apt install ./VELS-Syndicate-<version>.deb` |
| Linux (any) | `VELS-Syndicate-<version>.AppImage` | `chmod +x VELS-Syndicate-*.AppImage && ./VELS-Syndicate-*.AppImage` |

The app is not code-signed, so Windows will show "Windows protected your PC". Click **More info → Run anyway**. Compare the file against `SHA256SUMS.txt` to be sure it wasn't changed.

## Connecting two computers

1. Open the app on both computers. They need to be on the same Wi-Fi or wired network.
2. On the computer that wants to connect, open **Connections** and click **Request access**.
3. The other computer shows a 6-digit PIN. Type it on the requesting computer. That's it: from now on they reconnect by themselves.

If a computer doesn't show up, type its IP address under **Connect by IP address**.

## Phones and tablets

Send photos, videos, music and any other file between your computers and your **iPhone, iPad or Android** phone or tablet. There's no app to install: the phone uses its web browser.

1. On the PC, click **Phone QR** in the sidebar (or **Files → Connect phone or tablet**). A QR code appears.
2. Scan it with the phone's camera and tap the link. The phone must be on the same Wi-Fi.
3. Click **Allow** on the PC and give the phone a name. With **Remember this phone** on, it stays connected: next time open the bookmark or Home Screen icon, or just scan **Phone QR** again (a connected phone opens straight away, no new Allow).

The phone page uses the PC's accent color and follows the phone's own Light/Dark Mode.

On the phone page, **Send to PC** picks photos, videos or files; they arrive in the PC's received files folder. **Get from PC** shows files you sent to the phone from the Files tab, ready to download. Files can also go from one phone to another through the PC.

- **Private:** the page is served by your PC on your home network only. Nothing goes through the internet.
- **Encrypted:** the QR code holds a one-time code that never travels over the network. The phone and PC turn it into an encryption key, and the phone then gets its own key. Copied or replayed requests are refused.
- **One-time codes:** a code works once and expires after 2 minutes. You can remove a phone any time in **Connections → Phones & tablets**.
- Phones don't count toward your plan's PC limit. The plan's file size limit still applies, and phone downloads are limited to 2 GB per file.
- **iPhone:** downloads go to the **Files** app. To put a photo or video in **Photos**, open it in Files, tap **Share**, then **Save Image** or **Save Video**. The page shows these steps the first time.
- Keep the phone's screen on during big transfers. Phones pause web pages in the background; if a transfer stops, it continues where it left off.
- If the phone can't open the page, click **Allow VELS through the Windows firewall** in the connect window.
- Tip: in your router, give the PC a fixed (reserved) IP address. The phone page's address includes the PC's IP; if it changes, phones need to scan the code once more.

## NAS (home storage)

Available on **Pro, Team and Business**. One PC holds a folder that every paired PC and phone can use.

1. On the PC that's usually on (a big or external drive is best), open **NAS** → **Use this PC as the NAS** and choose a folder.
2. Other PCs open their **NAS** tab. The first time, the NAS PC asks what each one may do: **Full** (open, save, rename, delete), **View only** or **No access**. On family setups the main PC decides. Change it later in **NAS settings**.
3. Drag files onto the NAS tab or press **Upload**. Double-click a folder to open it; press **Get** to download a copy.

- **Kids folder:** kids' PCs (sharing activity with the main PC) see only the Kids folder and can save there without asking.
- **Recycle bin:** deleted files stay 30 days in the NAS recycle bin. With the bin off, they go to the NAS PC's Recycle Bin.
- **Keep awake:** while the NAS is on, the NAS PC doesn't go to sleep (the screen can still turn off).
- **Moving it:** **NAS settings → Move the NAS** picks a new folder on the same PC. On another PC, open **NAS → ⚙ → Move the NAS to this PC**. Choose **Copy everything over** or **Start empty**. Old files are never deleted.
- **Phones:** a phone connected to the NAS PC gets a **NAS** tab with **Save to NAS** and **Get**.
- A NAS on one drive isn't a backup. Keep a copy of important files somewhere else too.

## File history

In **Office**, click a PC and press **File history**. It lists everything that PC sent or received. You can open files that are also on this PC, **Get a copy**, **Send again** to another PC or phone, or **Delete on that PC** (to its Recycle Bin, with a note on that PC). On family setups this needs the main PC passcode.

## Main PC and parental controls

**The main PC.** One computer in the home is the main (parent) PC. When a computer connects for the first time, the computer asking for access asks *"Which PC is the main PC?"*. You pick one and choose a **4- or 6-digit passcode**. You can also do this later in **Settings → Main PC**. The passcode protects:
- the main PC's security settings, its list of computers and their permissions, and the **Family** page (unlocked for 10 minutes at a time, and locked again when the window is minimized)
- the parental settings on kids' PCs

The passcode is checked **by the main PC** over the encrypted link, so it can't be cracked from files on a kid's PC. With a 6-digit passcode, kids' PCs also keep a slow-to-crack backup check, so they can be changed while the main PC is off. With 4 digits, changes on a kid's PC need the main PC to be on.

**Activity sharing (Windows).** On a kid's PC, open **Settings → Parental controls → Set up…** and enter the main PC's passcode. The main PC's **Family** page then shows:
- a Discord-style live status: what's being played (with the game mode when the game shows it in its window title) or which website is open
- a daily history: screen time, the top games, apps and sites, and a timeline

The kid's PC always shows that it is being shared. Turning sharing off, removing the main PC or quitting the app needs the passcode.

What is shared: the name of the app or game in front, the game mode when shown in the window title, the page title, and when the PC is idle or locked. With **Include websites** on (the default), also the address of each web page visited, so the main PC can open it from the history. Nothing else is recorded: no keystrokes, screenshots, messages, camera or microphone. History stays on the kid's PC (7, 30 or 90 days), is sent only to the main PC when asked, and is deleted when sharing is turned off or when the main PC deletes it.

What goes over the internet: nothing, except (1) license checks with the store (the key and this PC's name, so buyers can tell their PCs apart), and (2) if **Describe websites in history** is on, the main PC reads the home page of a website it doesn't know once, to show a one-line description. Only public websites are contacted, never addresses on your network.

It is light on the PC: one small background helper checks the front window every 5 seconds, using about 0% CPU and roughly 50 MB of memory.

Limits: a kid with an administrator account can end the app in Task Manager or delete its data. The main PC then shows "Activity sharing is off" or "Offline". Give kids a standard Windows account. Games that don't show their mode in the window title (such as Fortnite or Roblox) are shown by name only.

## Build from source

You need [Node.js](https://nodejs.org) 20 or newer.

Windows (double-click `BUILD.bat`, or run):

```bat
npm install
npm test
npm run dist
```

Linux:

```bash
./build-linux.sh
```

Pushing a tag such as `v1.1.0` to GitHub also builds the Windows and Linux files automatically. Download them from the workflow run's **Artifacts** section.

## Security

| Area | What VELS Syndicate does |
|---|---|
| Authentication | Connecting needs a 6-digit PIN shown on the receiving computer, checked bit-by-bit so it can't be guessed or captured from the network. A wrong PIN changes the PIN, and 3 wrong tries block the requester for 5 minutes. After pairing, each reconnect proves both sides hold the shared key. |
| Access control | Each computer has its own permissions for running tasks, sending files and changing status (Ask, Allow or Never). Removing access on one computer removes it on both. New requests can be switched off, and connections from outside the local network are refused by default. |
| Encryption in transit | X25519 key exchange and AES-256-GCM, with fresh keys on every connection and a separate key per direction. Every message is numbered, so altered, replayed or reordered data ends the connection. |
| Encryption at rest | Pairing keys are locked with the operating system's keychain (Windows DPAPI, or the Linux Secret Service/KWallet). If no keychain is available, the Security page says so. Data files can only be read by your user account. |
| Input validation | Everything from another computer is type-checked, size-limited and cleaned. That covers file names (no `..`, drive letters or reserved names), display names (hidden text-direction characters removed) and stats. Unauthenticated connections are size- and time-limited, and floods or repeated failed sign-ins are blocked. |
| App hardening | The window is sandboxed, can't open websites or other windows, and is denied camera, microphone and other device permissions. Electron fuses turn off ways to hijack the app (`RunAsNode`, `NODE_OPTIONS`, debugger flags), and the app refuses to start if its files were changed (ASAR integrity check). Received files are marked as downloaded on Windows, so Windows warns before you open a program that came from another computer. |
| Main PC and parental controls | Activity goes only to the main PC, and other paired PCs are refused. The 4/6-digit passcode is stored only as a scrypt hash on the main PC and checked there, so it can't be cracked offline from a kid's PC. Kids' PCs get a backup hash only for 6-digit passcodes. 5 wrong tries lock the passcode for 5 minutes and alert the main PC. The main role can only be handed to another PC during its first setup. The kid's PC always shows that sharing is on. |
| Testing and updates | `npm test` runs the security and parental-control test suites, and GitHub Actions runs it on Windows and Linux for every change, together with `npm audit` and the privacy check. Dependabot opens pull requests when Electron or other tools need updates. |

To report a vulnerability, see [SECURITY.md](SECURITY.md). What changed in each version is in [CHANGELOG.md](CHANGELOG.md).

### Important to know

- A computer you set to **Run tasks: Allow** can run any command on your computer as your user. Only allow computers you fully control.
- Received files are saved as normal files. To protect them on a lost or stolen PC, turn on disk encryption (BitLocker or Device Encryption on Windows, LUKS on Linux).

## Before you upload your own copy

Run the privacy check. It stops if it finds personal paths, emails, public IP addresses, keys or app data files:

```
npm run privacy-check
```

To also catch your name, PC name or town, add them one per line to a file called `.privacy-words` in the project folder. That file is in `.gitignore` and is never uploaded.

## License

Source-available under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0): free for personal, family and other noncommercial use. Commercial use needs a Team or Business license. See [NOTICE.md](NOTICE.md).

---

VELS Syndicate is made by **VELS Labs**. © 2026 VELS Labs. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
