@echo off
setlocal
cd /d "%~dp0"

if not exist ".env" if exist ".env.example" copy /y ".env.example" ".env" >nul

set PANEL_HOST=127.0.0.1
set PANEL_PORT=3000
set DATA_DIR=.\data
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="PANEL_HOST" set PANEL_HOST=%%b
    if /i "%%a"=="PANEL_PORT" set PANEL_PORT=%%b
    if /i "%%a"=="DATA_DIR" set DATA_DIR=%%b
  )
)

if not exist "node\node.exe" goto missing_node
if not exist "apps\server\dist\index.js" goto missing_build

echo ============================================
echo  MC Panel {{VERSION}}
echo  URL:  http://%PANEL_HOST%:%PANEL_PORT%
echo  Data: %DATA_DIR%
echo  Keep this window open. Press Ctrl+C to stop.
echo ============================================
echo.
start "" cmd /c "timeout /t 2 >nul & start msedge http://%PANEL_HOST%:%PANEL_PORT%"
"node\node.exe" "apps\server\dist\index.js"
set EXITCODE=%ERRORLEVEL%
echo.
echo MC Panel exited (code %EXITCODE%).
pause
exit /b %EXITCODE%

:missing_node
echo [ERROR] node\node.exe is missing. Re-extract the portable package.
pause
exit /b 1

:missing_build
echo [ERROR] apps\server\dist\index.js is missing. Re-extract the portable package.
pause
exit /b 1
