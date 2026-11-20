# Security policy

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting instead: go to the repository's **Security** tab and choose **Report a vulnerability**. Include the steps to reproduce the problem and which version you used. You should get an answer within a week.

## Supported versions

Only the latest release gets security fixes. The app's About section (Settings) shows your version.

## What the app protects against

- Computers on your network that haven't been given access with a PIN. They can't run tasks, send files, see stats or change anything.
- Eavesdroppers and anyone tampering with network traffic. All traffic after pairing is encrypted and authenticated, and replayed or altered messages close the connection.
- PIN guessing. A wrong PIN changes the PIN, and 3 wrong tries block the requester. Requests are also rate-limited.
- Fake computers that copy another computer's name or ID. They fail the key check, and repeated failures block their address.
- Malicious file names, oversized messages, and connection floods from unpaired computers.

## What it can't protect against

- A paired computer you set to **Allow** for tasks. It can run any command as your user, because that is the feature.
- Malware already running on your computer as your user.
- Someone with physical access to an unlocked computer.
