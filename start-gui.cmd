@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

rem ---- 1. 找 Node：优先包内 node-runtime，其次 PATH ----
set "BUNDLED=%~dp0node-runtime\node.exe"
set "NODEEXE="
if exist "%BUNDLED%" set "NODEEXE=%BUNDLED%"
if defined NODEEXE goto :have_node
where node >nul 2>nul
if errorlevel 1 goto :no_node
set "NODEEXE=node"

:have_node
rem ---- 2. Light launcher serves the startup screen while the worker initializes ----
echo [AVC] node: %NODEEXE%
echo [AVC] starting: http://127.0.0.1:17890/   (close this window to stop)
"%NODEEXE%" "%~dp0src\gui-launcher.mjs"
pause
exit /b 0

:no_node
echo [AVC] Node.js not found.
echo [AVC] Install Node.js >= 22.13 from https://nodejs.org , or use the portable release.
pause
exit /b 1

