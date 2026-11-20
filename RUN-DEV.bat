@echo off
title VELS Syndicate - Run from source
cd /d "%~dp0"
if not exist "node_modules\electron" call npm install
rem Electron downloads itself the first time it starts
call npm start
