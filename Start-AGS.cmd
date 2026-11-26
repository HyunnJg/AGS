@echo off
setlocal
where node >nul 2>nul || (
  echo Install Node.js 24.22.3 or later in the 24.x line, then run Start-AGS again.
  if /i not "%~1"=="--check" pause
  exit /b 1
)
if /i "%~1"=="export" goto backup
if /i "%~1"=="restore" goto backup
cd /d "%~dp0"
node scripts/open-windows.mjs %*
if errorlevel 1 (
  if /i not "%~1"=="--check" pause
  exit /b 1
)
exit /b 0

:backup
node "%~dp0dist\scripts\state-backup.js" %*
exit /b %errorlevel%
