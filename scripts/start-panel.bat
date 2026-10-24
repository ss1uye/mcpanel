@echo off
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js 24 LTS or newer: https://nodejs.org/
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 24 (
  echo Node.js major version is %NODE_MAJOR%, but 24 or newer is required.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  if exist package-lock.json ( call npm ci ) else ( call npm install )
  if errorlevel 1 ( pause & exit /b 1 )
)

if not exist apps\web\dist\index.html (
  echo Building panel...
  call npm run build
  if errorlevel 1 ( pause & exit /b 1 )
)

set PANEL_HOST=127.0.0.1
set PANEL_PORT=3000
if exist .env (
  for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="PANEL_HOST" set PANEL_HOST=%%b
    if /i "%%a"=="PANEL_PORT" set PANEL_PORT=%%b
  )
)

echo Starting MC Panel at http://%PANEL_HOST%:%PANEL_PORT% ...
start "" cmd /c "timeout /t 2 >nul & start http://%PANEL_HOST%:%PANEL_PORT%"
call npm start
pause
