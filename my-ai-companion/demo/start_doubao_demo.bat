@echo off
REM Launch the FastAPI demo server that serves the frontend AND the doubao TTS
REM WebSocket proxy (/api/doubao-tts). This is required for the doubao voice
REM backend (Zhipu GLM brain + Doubao TTS voice output).
REM Serves on http://127.0.0.1:7860
chcp 65001 >nul

set "PYTHON=%~dp0..\env-myboy\Scripts\python.exe"
if not exist "%PYTHON%" set "PYTHON=%~dp0..\env-myboy\python.exe"
if not exist "%PYTHON%" set "PYTHON=python"

pushd "%~dp0"
echo Starting the doubao demo server, please wait...
"%PYTHON%" -m uvicorn server:app --host 127.0.0.1 --port 7860
echo.
echo Server exited.
pause