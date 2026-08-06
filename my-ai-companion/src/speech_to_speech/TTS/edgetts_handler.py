"""微软 Edge-TTS 后端（免 API Key）。

通过 edge-tts 库调用微软在线语音合成服务：
- 无需本地模型、无需 API Key，天然支持中文等 100+ 语言；
- 通过音色参数（如 zh-CN-XiaoxiaoNeural）选择中文甜美女声；
- 适合 CPU / Linux / Windows 环境，相比本地 MMS-TTS 极大提升合成速度与中文效果。

说明：Edge-TTS 通过 async 接口流式返回 MP3 音频，本 handler 将其
解码为 16kHz 单声道 int16 PCM，再按 blocksize 分块交给下游播放。
"""

from __future__ import annotations

import asyncio
import io
import logging
from threading import Event
from typing import Any, Iterator

import numpy as np
from rich.console import Console

from speech_to_speech.baseHandler import BaseHandler
from speech_to_speech.pipeline.cancel_scope import CancelScope
from speech_to_speech.pipeline.handler_types import TTSIn, TTSOut
from speech_to_speech.pipeline.messages import AUDIO_RESPONSE_DONE, EndOfResponse
from speech_to_speech.pipeline.speculative_turns import SpeculativeTurnTracker

logger = logging.getLogger(__name__)
console = Console()


def _edge_tts_synthesize_mp3(
    text: str,
    voice: str,
    rate: str = "+0%",
    volume: str = "+0%",
    pitch: str = "+0Hz",
) -> bytes:
    """调用 Edge-TTS 在线合成，返回完整的 MP3 字节流。"""
    import edge_tts

    data = bytearray()

    async def _run() -> None:
        communicate = edge_tts.Communicate(
            text,
            voice,
            rate=rate,
            volume=volume,
            pitch=pitch,
        )
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                data.extend(chunk["data"])

    asyncio.run(_run())
    return bytes(data)


class EdgeTTSHandler(BaseHandler[TTSIn, TTSOut]):
    """基于微软 Edge-TTS 的在线语音合成 handler。"""

    def setup(
        self,
        should_listen: Event,
        voice: str = "zh-CN-XiaoxiaoNeural",
        rate: str = "+0%",
        volume: str = "+0%",
        pitch: str = "+0Hz",
        blocksize: int = 512,
        cancel_scope: CancelScope | None = None,
        speculative_turns: SpeculativeTurnTracker | None = None,
        **kwargs: Any,
    ) -> None:
        self.should_listen = should_listen
        self.voice = voice
        self.rate = rate
        self.volume = volume
        self.pitch = pitch
        self.blocksize = blocksize
        self.cancel_scope = cancel_scope
        self.speculative_turns = speculative_turns

        self._initial_voice = self.voice
        self.warmup()

    def warmup(self) -> None:
        logger.info(f"Warming up {self.__class__.__name__}")
        # 打印当前音色，便于排查是否被前端 session voice 覆盖成英文音色
        logger.info(f"EdgeTTSHandler using voice: {self.voice}")
        # 预热 Edge-TTS 服务，确保首次对话时不需要额外等待联网建立连接
        self._generate_pcm("你好，我是小姚。")

    def _generate_pcm(self, text: str) -> np.ndarray:
        """合成指定文本并返回 16kHz 单声道 int16 PCM 数组。"""
        import soundfile as sf

        mp3_bytes = _edge_tts_synthesize_mp3(text, self.voice, self.rate, self.volume, self.pitch)
        # Edge-TTS 输出默认 24kHz；libsndfile 可直接解码 MP3
        audio, sr = sf.read(io.BytesIO(mp3_bytes), dtype="float32")

        # 统一重采样到 16kHz
        if sr != 16000:
            from scipy.signal import resample_poly

            gcd = np.gcd(sr, 16000)
            audio = resample_poly(audio, up=16000 // gcd, down=sr // gcd)

        # 转为 int16 PCM
        return (audio.astype(np.float32) * 32768.0).astype(np.int16)

    def process(self, tts_input: TTSIn) -> Iterator[TTSOut]:
        speculative_turns = getattr(self, "speculative_turns", None)
        if isinstance(tts_input, EndOfResponse):
            if speculative_turns and not speculative_turns.is_latest_after_reopen_grace(
                tts_input.turn_id,
                tts_input.turn_revision,
            ):
                return
            yield AUDIO_RESPONSE_DONE
            return

        if speculative_turns and not speculative_turns.is_latest_after_reopen_grace(
            tts_input.turn_id,
            tts_input.turn_revision,
        ):
            logger.debug("Dropping stale TTS input for turn=%s rev=%s", tts_input.turn_id, tts_input.turn_revision)
            return
        if speculative_turns:
            speculative_turns.commit(tts_input.turn_id, tts_input.turn_revision)

        gen = self.cancel_scope.generation if self.cancel_scope else None
        text = tts_input.text

        console.print(f"[green]ASSISTANT: {text}")
        logger.debug(f"Processing text: {text}")

        audio = self._generate_pcm(text)
        if audio is None or len(audio) == 0:
            logger.warning("No audio output generated")
            return

        for i in range(0, len(audio), self.blocksize):
            if gen is not None and self.cancel_scope is not None and self.cancel_scope.is_stale(gen):
                logger.info("TTS generation cancelled (interruption)")
                return
            chunk = audio[i : i + self.blocksize]
            if len(chunk) < self.blocksize:
                chunk = np.pad(chunk, (0, self.blocksize - len(chunk)))
            yield chunk

    def on_session_end(self) -> None:
        self.voice = self._initial_voice
        logger.debug("Edge TTS session state reset")