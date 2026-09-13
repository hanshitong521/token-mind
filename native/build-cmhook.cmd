@echo off

setlocal

cd /d "%~dp0"

set OUT=%~dp0..\cursor\hooks

where rustc >nul 2>&1

if errorlevel 1 (

  echo ERROR: rustc required — install from https://rustup.rs

  exit /b 1

)

rustc -O cmhook.rs -o "%OUT%\cmhook.exe"

if errorlevel 1 exit /b 1

del /q "%OUT%\cmhook.dll" "%OUT%\cmhook.deps.json" "%OUT%\cmhook.runtimeconfig.json" "%OUT%\cmhook.pdb" 2>nul

echo built rust %OUT%\cmhook.exe

exit /b 0

