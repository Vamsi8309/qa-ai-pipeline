@echo off
echo Starting QA AI Pipeline...
cd /d "%~dp0"
start "" http://localhost:3000/dashboard
node server.js
pause
