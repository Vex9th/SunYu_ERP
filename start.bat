@echo off
setlocal
cd /d "%~dp0"

SunYu_ERP.exe
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo SunYu ERP stopped with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
