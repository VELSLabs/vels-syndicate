#!/usr/bin/env bash
# Builds the Linux versions of VELS Syndicate (.AppImage and .deb) into the USB-Ready folder.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo " Node.js is not installed. On Ubuntu/Debian install it with:"
  echo
  echo "   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
  echo
  exit 1
fi

echo; echo " [1/5] Installing build tools..."
npm install --no-fund

echo; echo " [2/5] Running security tests..."
npm test

echo; echo " [3/5] Privacy check..."
npm run privacy-check

echo; echo " [4/5] Checking dependencies for known vulnerabilities..."
npm audit --audit-level=high || echo " WARNING: npm audit found issues — run 'npm audit' to see them."

echo; echo " [5/5] Building AppImage and .deb..."
npm run dist:linux

mkdir -p USB-Ready
cp dist/*.AppImage dist/*.deb USB-Ready/
cp USB-README.txt USB-Ready/
(cd USB-Ready && sha256sum *.AppImage *.deb > SHA256SUMS-linux.txt)

echo
echo " Done! The Linux files are in the USB-Ready folder."
