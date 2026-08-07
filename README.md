# 陪伴交流系统（MyBBBOY）

一个基于「语音识别 + 大语言模型 + 语音合成」的实时 AI 语音陪伴系统。用户可以用语音与一个名为"小姚"的温暖中文陪伴角色对话，页面上由视频状态机驱动的数字人会在「待机 / 思考 / 说话」三种状态间无缝切换。

本项目基于 Hugging Face 的实时语音对话（speech-to-speech）管道改造而来，核心代码位于 `my-ai-companion/`。

## 功能特性

- **语音对话**：实时语音输入 → 文字理解 → 语音回复，全链路本地/云端混合处理。
- **视频数字人**：`demo/video-state-machine.js` 实现三态视频状态机，待机序列（`idle-1/2/3.mp4`）、思考（`thinking.mp4`）、说话（`speaking.mp4`）之间无缝切换，无闪黑、无亮度跳变。
- **中文陪伴角色**：LLM 系统提示词内置为简体中文角色"小姚"，回复简洁自然。

## 技术栈

| 环节 | 方案 |
| ---- | ---- |
| 语音识别 STT | faster-whisper（CTranslate2，CPU，`small` 模型，语言固定 `zh`） |
| 大语言模型 LLM | DeepSeek（OpenAI 兼容 `chat-completions` 接口，`deepseek-chat`） |
| 语音合成 TTS | Microsoft Edge-TTS（免费、无需 API Key，中文女声 `zh-CN-XiaoxiaoNeural`） |
| 实时服务 | WebSocket（`ws://localhost:8765/v1/realtime`） |
| 前端 | 原生 HTML / CSS / JavaScript（静态页，SvelteKit 风格 Tailwind 之外的轻量实现） |

## 目录结构

```
陪伴交流系统/
├── my-ai-companion/           # 主项目（基于 Hugging Face speech-to-speech 改造）
│   ├── src/speech_to_speech/  # 语音对话核心管道（STT / LLM / TTS / VAD / API）
│   ├── demo/                  # 前端演示（静态页 + 视频状态机数字人）
│   │   ├── data/              # 数字人动作视频素材
│   │   ├── index.html / main.js / style.css
│   │   └── video-state-machine.js
│   ├── start_realtime.bat     # 一键启动后端语音服务
│   └── start_frontend.bat     # 一键启动前端静态服务器
├── 素材/                      # 数字人动作 / 图片素材源文件
└── README.md
```

## 环境要求

- Windows 系统
- Python 环境：项目使用 conda 环境 `env-myboy`（路径 `my-ai-companion/env-myboy/python.exe`）
- 首次运行会自动下载 STT / TTS 模型

## 快速启动

### 1. 配置 DeepSeek API Key

后端通过环境变量 `OPENAI_API_KEY` 读取 DeepSeek 密钥（出于安全考虑，密钥没有硬编码在代码或脚本中）。

```bat
setx OPENAI_API_KEY "你的DeepSeekKey"
```

设置完成后请**重新打开一个终端**再继续。

### 2. 启动后端语音服务

双击运行 `my-ai-companion/start_realtime.bat`，服务会监听在 `ws://localhost:8765/v1/realtime`。

### 3. 启动前端

双击运行 `my-ai-companion/start_frontend.bat`，然后在浏览器打开：

```
http://127.0.0.1:7860/
```

## 常见问题

- **提示 "未检测到环境变量 OPENAI_API_KEY"**：请先执行第 1 步设置环境变量，并重新打开终端后再启动后端。
- **数字人视频未更新**：浏览器可能缓存了旧素材，请按 `Ctrl + F5` 强制刷新。

## 说明

- 本项目为私有/个人项目，用于跨设备远程开发。数字人素材位于 `素材/` 目录，运行所需的副本位于 `my-ai-companion/demo/data/`。