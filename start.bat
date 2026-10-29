@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Нужен Node.js. Скачай с https://nodejs.org и запусти этот файл ещё раз.
  pause
  exit /b
)
set HOST_KEY=%RANDOM%%RANDOM%
set PORT=3000
if not "%~1"=="" set PUBLIC_URL=%~1
echo Запускаю игру. Окно не закрывай, пока идёт презентация.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%/host?k=%HOST_KEY%"
node server.js
pause
