@echo off
title VELS Syndicate - Copy to USB
cd /d "%~dp0"

if not exist "USB-Ready\USB-README.txt" (
  echo.
  echo  Nothing to copy yet. Run BUILD.bat first.
  pause
  exit /b 1
)

echo.
echo  Plug in the USB stick, then type its drive letter.
echo  (Look in File Explorer under "This PC" - for example F)
echo.
set /p DRIVE= USB drive letter:
set DRIVE=%DRIVE::=%
if "%DRIVE%"=="" exit /b 1
if /i "%DRIVE%"=="C" (
  echo  C: is your main drive, not a USB stick. Stopping.
  pause
  exit /b 1
)
if not exist "%DRIVE%:\" (
  echo  Drive %DRIVE%: was not found.
  pause
  exit /b 1
)

echo.
echo  Copying to %DRIVE%:\VELS Syndicate ...
robocopy "USB-Ready" "%DRIVE%:\VELS Syndicate" /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo  Copy failed.
  pause
  exit /b 1
)
echo  Done. On the other PC, open the "VELS Syndicate" folder on the USB.
explorer "%DRIVE%:\VELS Syndicate"
pause
