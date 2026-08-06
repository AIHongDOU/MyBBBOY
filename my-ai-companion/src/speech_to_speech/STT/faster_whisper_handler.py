from __future__ import annotations

import logging
import os
from typing import Any, Iterator

from faster_whisper import WhisperModel
from rich.console import Console

from speech_to_speech.pipeline.handler_types import STTIn, STTOut
from speech_to_speech.pipeline.messages import Transcription
from speech_to_speech.STT.base_stt_handler import BaseSTTHandler

console = Console()

logger = logging.getLogger(__name__)

# 繁体转简体转换器（懒加载，仅当真正需要时初始化）
_t2s = None


def _to_simplified(text: str) -> str:
    """将文本（可能含繁体字）转为简体中文。

    使用 OpenCC（opencc-python-reimplemented）的 t2s 转换，
    对英文等非中文文本无副作用。
    """
    global _t2s
    if _t2s is None:
        from opencc import OpenCC

        _t2s = OpenCC("t2s")  # 繁体 -> 简体
    return _t2s.convert(text)


class FasterWhisperSTTHandler(BaseSTTHandler):
    """
    Handles the Speech To Text generation using a Whisper model.
    """

    def setup(
        self,
        model_name: str = "tiny.en",
        device: str = "auto",
        compute_type: str = "auto",
        gen_kwargs: dict[str, Any] = {},
    ) -> None:
        self.gen_kwargs = self.adapt_gen_kwargs(gen_kwargs)

        os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
        self.model = WhisperModel(model_name, device=device, compute_type=compute_type)

    def process(self, vad_audio: STTIn) -> Iterator[STTOut]:
        logger.debug("infering faster whisper...")

        segments, info = self.model.transcribe(vad_audio.audio, **self.gen_kwargs)
        output_text = []

        for segment in segments:
            logger.debug("[%.2fs -> %.2fs] %s" % (segment.start, segment.end, segment.text))
            output_text.append(segment.text)

        pred_text = " ".join(output_text).strip()

        logger.debug("finished whisper inference")
        if pred_text:
            # 统一转为简体中文，避免 Whisper 偶尔输出繁体字
            pred_text = _to_simplified(pred_text)
            console.print(f"[yellow]USER: {pred_text}")

            yield Transcription(
                text=pred_text,
                turn_id=vad_audio.turn_id,
                turn_revision=vad_audio.turn_revision,
                speech_stopped_at_s=vad_audio.created_at_s,
            )
        else:
            logger.debug("no text detected. skipping...")

    def cleanup(self) -> None:
        logger.info("Stopping FasterWhisperSTTHandler")
        del self.model

    def adapt_gen_kwargs(self, gen_kwargs: dict[str, Any]) -> dict[str, Any]:
        # 关闭时间戳输出，减少解码开销
        gen_kwargs["without_timestamps"] = not gen_kwargs.pop("return_timestamps", True)

        # 开启 Whisper 内置的语音活动检测（VAD）过滤：
        # 剔除静音与纯环境噪声片段，减少误识别，同时因不转写无意义片段而提速
        gen_kwargs.setdefault("vad_filter", True)

        # 关闭上下文关联：避免长音频把前一句文本重复带上，减少噪声型错字并加快推理
        gen_kwargs.setdefault("condition_on_previous_text", False)

        return gen_kwargs
