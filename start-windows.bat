@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js from https://nodejs.org/
  pause
  exit /b 1
)
if not exist "node_modules\socket.io" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Installation failed. Check your internet connection.
    pause
    exit /b 1
  )
)
echo Starting the game...
node server.js
pause
