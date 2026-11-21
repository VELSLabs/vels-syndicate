@echo off
title VELS Syndicate - Publish 1.9.0 to GitHub
cd /d "%~dp0"
echo.
echo  This uploads the code to github.com/VELSLabs/vels-syndicate, tags v1.9.0
echo  and opens the release page. Nothing is published until you click
echo  "Publish release" on that page.
echo.
for /f "delims=" %%e in ('git config user.email') do set "GITMAIL=%%e"
echo  Commits are signed with: %GITMAIL%
echo %GITMAIL% | find /i "noreply" >nul
if errorlevel 1 (
  echo.
  echo  STOPPED: that is not your private GitHub address.
  echo  Set it first:  git config user.email "YOUR-ID+VELSLabs@users.noreply.github.com"
  goto end
)
git config user.name "VELS Labs"

echo.
echo  [1/4] Privacy check...
call npm run privacy-check
if errorlevel 1 goto fail

echo.
echo  [2/4] Saving this version (commit)...
git add .
git diff --cached --quiet || git commit -m "VELS Syndicate 1.9.0"
if errorlevel 1 goto fail

echo.
echo  [3/4] Uploading to GitHub...
git remote get-url origin >nul 2>nul || git remote add origin https://github.com/VELSLabs/vels-syndicate.git
git push -u origin main
if errorlevel 1 goto fail

echo.
echo  [4/4] Tagging v1.9.0...
git rev-parse -q --verify refs/tags/v1.9.0 >nul || git tag v1.9.0
git push origin v1.9.0
if errorlevel 1 goto fail

echo.
echo  Uploaded. Opening the release page and the USB-Ready folder.
echo  Drag these 3 files onto the release page, then click "Publish release":
echo    VELS-Syndicate-Setup-1.9.0.exe
echo    VELS-Syndicate-Portable-1.9.0.exe
echo    SHA256SUMS.txt
start "" "https://github.com/VELSLabs/vels-syndicate/releases/new?tag=v1.9.0&title=VELS+Syndicate+1.9.0&body=Download+%%2A%%2AVELS-Syndicate-Setup-1.9.0.exe%%2A%%2A+%%28installs+and+updates%%29+or+%%2A%%2AVELS-Syndicate-Portable-1.9.0.exe%%2A%%2A+%%28runs+without+installing%%29.+Check+downloads+against+SHA256SUMS.txt.%%0A%%0A%%23%%23+What%%27s+new%%0A-+Phones+and+tablets+%%281.8%%29%%3A+scan+a+QR+code+to+send+photos%%2C+videos+and+files+between+your+PCs+and+an+iPhone%%2C+iPad+or+Android.+Nothing+to+install+on+the+phone.%%0A-+NAS+%%28Pro+and+up%%29%%3A+one+shared+folder+for+the+whole+home%%2C+with+Full+%%2F+View+only+%%2F+No+access+per+PC%%2C+a+Kids+folder%%2C+a+30-day+recycle+bin+and+a+NAS+tab+on+phones.%%0A-+File+history%%3A+in+Office%%2C+open+a+PC+to+see+everything+it+sent+or+received%%2C+then+open%%2C+get+a+copy%%2C+send+again+or+delete.%%0A-+Rename+the+sidebar+and+phone+tabs+on+each+PC.%%0A-+New+installs+start+in+Green.%%0A%%0AFull+list%%3A+CHANGELOG.md"
explorer "USB-Ready"
goto end

:fail
echo.
echo  Something went wrong. Scroll up to see the error.
:end
echo.
pause
