@echo off
setlocal
where node >nul 2>&1
if errorlevel 1 exit /b 0
node "%~dp0cm-pre-tool.mjs"
exit /b %ERRORLEVEL%
