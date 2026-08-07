@echo off
REM Switch cmd to UTF-8 so the Chinese init_chat_prompt below is parsed correctly.
chcp 65001 >nul

REM ============================================================
REM Launch the Hugging Face speech-to-speech realtime service (DeepSeek) v2
REM ------------------------------------------------------------
REM Use the HF mirror (replace huggingface.co) for any model downloads, and
REM keep the hub offline so cached models (Smart Turn, etc.) load without
REM needing to reach huggingface.co. Edge-TTS and DeepSeek use their own APIs.
set "HF_ENDPOINT=https://hf-mirror.com"
set "HF_HUB_OFFLINE=1"
REM Summary:
REM   - LLM: DeepSeek official OpenAI-compatible endpoint (chat-completions)
REM   - STT: faster-whisper (CTranslate2, much faster on CPU than openai/whisper-small)
REM          Language fixed to zh for the Chinese companion.
REM   - TTS: Microsoft Edge-TTS (free, no API key, online). Chinese voice
REM          zh-CN-XiaoxiaoNeural (sweet female voice). Fast and no local model.
REM   - Service listens on ws://localhost:8765/v1/realtime
REM   - Browser demo connects to this service via SPEECH_TO_SPEECH_URL
REM ============================================================

REM Use the project env env-myboy Python. Support both conda-style
REM (env-myboy\python.exe) and standard venv (env-myboy\Scripts\python.exe) layouts.
set "PYTHON=%~dp0env-myboy\Scripts\python.exe"
if not exist "%PYTHON%" set "PYTHON=%~dp0env-myboy\python.exe"
if not exist "%PYTHON%" (
    echo [ERROR] env-myboy Python not found. Please create the env-myboy environment first.
    pause
    exit /b 1
)

REM DeepSeek API Key: read from the OPENAI_API_KEY env var (not hardcoded).
REM Set OPENAI_API_KEY in your user/system environment before running.
if "%OPENAI_API_KEY%"=="" (
    echo [ERROR] OPENAI_API_KEY is not set. Set it first, then start again.
    pause
    exit /b 1
)

echo Starting the realtime speech service, please wait (first run downloads STT/TTS models)...
"%PYTHON%" -m speech_to_speech.s2s_pipeline ^
    --mode realtime ^
    --stt faster-whisper ^
    --faster_whisper_stt_model_name "%~dp0models\faster-whisper-small" ^
    --faster_whisper_stt_device cpu ^
    --faster_whisper_stt_compute_type int8 ^
    --faster_whisper_stt_gen_language zh ^
    --llm_backend chat-completions ^
    --tts edgetts ^
    --edge_tts_voice zh-CN-XiaoxiaoNeural ^
    --model_name deepseek-chat ^
    --responses_api_base_url https://api.deepseek.com/v1 ^
    --responses_api_api_key %OPENAI_API_KEY% ^
    --responses_api_disable_thinking False ^
    --responses_api_stream ^
    --init_chat_prompt "你是小姚，一个温暖贴心的中文陪伴角色。请始终使用简体中文、简洁自然地回复，控制在20字以内。" ^
    --enable_live_transcription

echo.
echo Service exited.
pause