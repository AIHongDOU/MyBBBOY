@echo off
REM Switch cmd to UTF-8 so the Chinese init_chat_prompt below is parsed correctly.
chcp 65001 >nul
REM ============================================================
REM Launch the Hugging Face speech-to-speech realtime service (DeepSeek) v2
REM ------------------------------------------------------------
REM Summary:
REM   - LLM: DeepSeek official OpenAI-compatible endpoint (chat-completions)
REM   - STT: faster-whisper (CTranslate2, much faster on CPU than openai/whisper-small)
REM          Language fixed to zh for the Chinese companion.
REM   - TTS: Microsoft Edge-TTS (free, no API key, online). Chinese voice
REM          zh-CN-XiaoxiaoNeural (sweet female voice). Fast and no local model.
REM   - Service listens on ws://localhost:8765/v1/realtime
REM   - Browser demo connects to this service via SPEECH_TO_SPEECH_URL
REM ============================================================

REM Use the project conda env env-myboy Python
set "PYTHON=%~dp0env-myboy\python.exe"
if not exist "%PYTHON%" (
    echo [ERROR] env-myboy Python not found. Please create the env-myboy environment first.
    pause
    exit /b 1
)

REM DeepSeek API Key：从系统环境变量 OPENAI_API_KEY 读取，避免密钥硬编码进仓库泄露。
REM 使用前请先在系统/用户环境变量中设置 OPENAI_API_KEY（值为你的 DeepSeek API Key）。
if "%OPENAI_API_KEY%"=="" (
    echo [ERROR] 未检测到环境变量 OPENAI_API_KEY，请先设置后再启动。
    pause
    exit /b 1
)

echo Starting the realtime speech service, please wait (first run downloads STT/TTS models)...
"%PYTHON%" -m speech_to_speech.s2s_pipeline ^
    --mode realtime ^
    --stt faster-whisper ^
    --faster_whisper_stt_model_name small ^
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