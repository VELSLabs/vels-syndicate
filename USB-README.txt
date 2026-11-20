VELS Syndicate - setting up another computer
============================================

WINDOWS - pick one:

  A) VELS-Syndicate-Portable-<version>.exe
     Nothing to install. Copy it anywhere (Desktop is fine) and double-click it.

  B) VELS-Syndicate-Setup-<version>.exe
     Installs it with a Desktop and Start menu shortcut. Uninstall later from
     Settings > Apps like any other program.

  First launch:
  1. Windows may say "Windows protected your PC" (the app isn't signed).
     Click "More info", then "Run anyway".
  2. If Windows Firewall asks, tick "Private networks" and click "Allow".
     (Or open the app > Settings > Firewall > Allow.)
  3. Your network must be set to "Private":
     Settings > Network & internet > Wi-Fi (or Ethernet) > your network > Private.

LINUX - pick one:

  A) VELS-Syndicate-<version>.deb   (Ubuntu, Debian, Mint, Pop!_OS - recommended)
       sudo apt install ./VELS-Syndicate-<version>.deb
     Then open "VELS Syndicate" from your apps menu.

  B) VELS-Syndicate-<version>.AppImage   (any distro, nothing to install)
       chmod +x VELS-Syndicate-<version>.AppImage
       ./VELS-Syndicate-<version>.AppImage
     On Ubuntu 22.04+ you may first need:  sudo apt install libfuse2
     (on Ubuntu 24.04 the package is called libfuse2t64)

  If the firewall (ufw) is on, open the app > Settings > Firewall > Allow.

Check the download (optional)
-----------------------------
SHA256SUMS.txt lists a fingerprint for each file. To check one:
  Windows:  certutil -hashfile VELS-Syndicate-Portable-<version>.exe SHA256
  Linux:    sha256sum -c SHA256SUMS-linux.txt

Connecting two computers
------------------------
1. Open the app on both computers.
2. On the computer that wants to connect, go to Connections. The other one
   appears under "Nearby" - click "Request access".
3. The OTHER computer pops up a 6-digit PIN. Type that PIN on the requesting
   computer. Done - they reconnect on their own from now on.
   - A wrong PIN makes the other computer show a NEW PIN. After 3 wrong tries
     the requesting computer is blocked for 5 minutes.
   - Didn't expect a request? Click Deny.
4. In Connections you can set what each computer is allowed to do on yours
   (run tasks, send files, change your status): Ask, Allow or Never.

If a computer never shows up under Nearby, type its IP address in
"Connect by IP address" (find it with  ipconfig  on Windows or  ip -brief address  on Linux).
