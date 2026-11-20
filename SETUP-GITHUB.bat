@echo off
title VELS Syndicate - GitHub setup
cd /d "%~dp0"
if not exist "github-files\ci.yml" (
  echo  Already done.
  pause
  exit /b 0
)
mkdir ".github\workflows" 2>nul
move /y "github-files\ci.yml" ".github\workflows\ci.yml" >nul
move /y "github-files\dependabot.yml" ".github\dependabot.yml" >nul
rmdir "github-files" 2>nul
echo.
echo  Done. The GitHub test robot (CI) and update checker (Dependabot) are in place.
pause
