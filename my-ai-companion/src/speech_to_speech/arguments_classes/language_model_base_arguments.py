from dataclasses import dataclass, field


@dataclass
class LanguageModelBaseArguments:
    model_name: str = field(
        default="Qwen/Qwen3-4B-Instruct-2507",
        metadata={"help": "The pretrained language model to use."},
    )
    user_role: str = field(
        default="user",
        metadata={"help": "Role assigned to the user in the chat context. Default is 'user'."},
    )
    init_chat_role: str = field(
        default="system",
        metadata={"help": "Initial role for setting up the chat context. Default is 'system'."},
    )
    init_chat_prompt: str = field(
        default="你是小姚，一个温暖贴心的中文陪伴角色。请始终使用简体中文、简洁自然地回复，控制在20字以内。",
        metadata={"help": "The initial chat prompt to establish context for the language model."},
    )
    chat_size: int = field(
        default=30,
        metadata={"help": "Number of interactions assistant-user to keep for the chat."},
    )
    stream_batch_sentences: int = field(
        default=3,
        metadata={
            "help": "Number of sentences to accumulate before yielding a batch during streaming. "
            "Set to 1 for sentence-by-sentence streaming. Default is 3."
        },
    )
    enable_lang_prompt: bool = field(
        default=False,
        metadata={
            "help": "When True, append a user message instructing the model to reply in the detected/selected "
            "language (e.g. 'Please reply to my message in French.'). Default is False."
        },
    )
    compact_history: bool = field(
        default=True,
        metadata={
            "help": "When True, summarize older turns in the background once the chat exceeds chat_size, "
            "instead of synchronously evicting them. Adds an extra LLM call per compaction. Default is True."
        },
    )
