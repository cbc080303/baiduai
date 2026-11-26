@echo off
rem Meeting Todo QC - one-click install (Windows)
rem Copies meeting-todo-qc into the DuMate plugin directory of every user profile found.
setlocal enabledelayedexpansion
set "SRC=%~dp0meeting-todo-qc"
set "BASE=%APPDATA%\qianfan-desktop-app\qianfan_desk_xdg"

if not exist "%SRC%\plugin.json" (
  echo [ERR] meeting-todo-qc folder not found next to this script.
  pause & exit /b 1
)
if not exist "%BASE%" (
  echo [ERR] DuMate data dir not found: %BASE%
  echo Open the DuMate client once, then run this again.
  pause & exit /b 1
)

set "DONE="
for /d %%D in ("%BASE%\*") do (
  if exist "%%D\data\plugins\user" (
    xcopy "%SRC%" "%%D\data\plugins\user\meeting-todo-qc\" /E /I /Y >nul
    echo [OK] installed to %%D\data\plugins\user\meeting-todo-qc
    set "DONE=1"
  )
)

if not defined DONE (
  echo [ERR] no data\plugins\user directory found under %BASE%
  echo Create it manually, or copy the folder by hand - see QUICKSTART.md
  pause & exit /b 1
)

echo.
echo Restart the DuMate client, then open "Plugins" in the left sidebar.
echo Verify with:  python "%%USERPROFILE%%\...\meeting-todo-qc\skills\meeting-todo-qc\scripts\qc.py" --check
pause