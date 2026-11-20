@echo off
title VELS Syndicate - Build
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed on this PC.
  echo  Install it with this command, then run BUILD.bat again:
  echo.
  echo     winget install OpenJS.NodeJS.LTS
  echo.
  pause
  exit /b 1
)

echo.
echo  [1/6] Installing build tools (first time takes a few minutes)...
call npm install --no-fund
if errorlevel 1 goto fail

echo.
echo  [2/6] Running security tests...
call npm test
if errorlevel 1 goto fail

echo.
echo  [3/6] Privacy check (no personal info in the project)...
call npm run privacy-check
if errorlevel 1 goto fail

echo.
echo  [4/6] Checking dependencies for known vulnerabilities...
call npm audit --audit-level=high
if errorlevel 1 echo  WARNING: npm audit found issues - run "npm audit" to see them.

echo.
echo  [5/6] Building the portable app and the installer...
call npm run dist
if errorlevel 1 goto fail

echo.
echo  [6/6] Putting the USB files together...
if exist "USB-Ready" rmdir /s /q "USB-Ready"
mkdir "USB-Ready"
copy /y "dist\VELS-Syndicate-Portable-*.exe" "USB-Ready\" >nul
copy /y "dist\VELS-Syndicate-Setup-*.exe" "USB-Ready\" >nul
copy /y "USB-README.txt" "USB-Ready\" >nul
powershell -NoProfile -Command "Get-FileHash 'USB-Ready\*.exe' -Algorithm SHA256 | ForEach-Object { $_.Hash.ToLower() + '  ' + (Split-Path $_.Path -Leaf) } | Set-Content 'USB-Ready\SHA256SUMS.txt'"

echo.
echo  Done! Everything for the USB is in the USB-Ready folder.
echo  Run COPY-TO-USB.bat to copy it onto a USB stick.
explorer "USB-Ready"
pause
exit /b 0

:fail
echo.
echo  Something went wrong. Scroll up to see the error.
pause
exit /b 1
