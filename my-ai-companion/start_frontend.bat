@echo off
REM Switch cmd to UTF-8 so paths with Chinese characters are handled correctly.
chcp 65001 >nul
REM ============================================================
REM Launch the frontend demo (static page) for the companion system.
REM ------------------------------------------------------------
REM   - Serves the static frontend in .\demo on http://127.0.0.1:7860
REM   - The page connects to the voice backend at
REM     ws://localhost:8765/v1/realtime (start it first via start_realtime.bat)
REM   - Simple static server (python http.server), no build step needed.
REM ============================================================

REM Use the project env Python if available, else fall back to system python.
set "PYTHON=%~dp0env-myboy\Scripts\python.exe"
if not exist "%PYTHON%" set "PYTHON=%~dp0env-myboy\python.exe"
if not exist "%PYTHON%" set "PYTHON=python"

REM Move into the demo folder so the page assets resolve correctly.
pushd "%~dp0demo"

echo Starting the frontend demo, please wait...
"%PYTHON%" -m http.server 7860

echo.
echo Frontend exited.
pause