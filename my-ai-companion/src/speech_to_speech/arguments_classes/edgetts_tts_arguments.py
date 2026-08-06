from dataclasses import dataclass, field


@dataclass
class EdgeTTSHandlerArguments:
    """参数类：微软 Edge-TTS 后端（免 API Key，在线合成）。

    通过 edge-tts 库调用微软在线语音合成服务，无需本地模型与 API Key，
    天然支持中文等多种语言，适合 CPU/Linux/Windows 环境使用。
    """

    edge_tts_voice: str = field(
        default="zh-CN-XiaoxiaoNeural",
        metadata={"help": "Edge-TTS 音色名称。中文甜美女声默认 zh-CN-XiaoxiaoNeural。"},
    )
    edge_tts_rate: str = field(
        default="+0%",
        metadata={"help": "语速调节，形如 '+10%' / '-10%'。默认 '+0%'。"},
    )
    edge_tts_volume: str = field(
        default="+0%",
        metadata={"help": "音量调节，形如 '+0%'。默认 '+0%'。"},
    )
    edge_tts_pitch: str = field(
        default="+0Hz",
        metadata={"help": "音高调节，形如 '+0Hz'。默认 '+0Hz'。"},
    )