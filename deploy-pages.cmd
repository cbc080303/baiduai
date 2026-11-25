@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ==== GitHub Pages Deploy ====
echo 1. Browser will open github.com/login/device
echo 2. The one-time code is already in your clipboard - press Ctrl+V
echo 3. Click Authorize
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; & '%~dp0deploy-pages.ps1'"
echo.
echo ==== Done. Copy the URL above into your submission form. ====
pause
