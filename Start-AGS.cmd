@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Install Node.js 24.22.3 or later in the 24.x line, then run Start-AGS again.
  if /i not "%~1"=="--check" pause
  exit /b 1
)
node scripts/open-windows.mjs %*
if errorlevel 1 (
  if /i not "%~1"=="--check" pause
  exit /b 1
)
exit /b 0
