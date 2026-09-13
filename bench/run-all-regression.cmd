@echo off
setlocal
cd /d "%~dp0.."
set PROJ=e:\workA\shejiuPro
echo === install ===
node contextmind\cli.mjs install %PROJ%
if errorlevel 1 exit /b 1
echo === stress-complex ===
node bench\stress-complex.mjs
if errorlevel 1 exit /b 1
echo === hook_matrix ===
node bench\hook_matrix.mjs
if errorlevel 1 exit /b 1
echo === verify-cmhook ===
node bench\verify-cmhook.mjs
if errorlevel 1 exit /b 1
echo === hook_latency ===
node bench\hook_latency.mjs 16
echo === doctor ===
node contextmind\cli.mjs doctor %PROJ%
exit /b 0
