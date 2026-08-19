#!/usr/bin/env python3
"""Kokoro-based text-to-speech, synthesized per-sentence for a low-latency
speech-to-speech pipeline.

Usage pattern (see main.py's generator_wrapper):
  1. Feed streamed text tokens into a SentenceAccumulator as they arrive.
  2. Whenever it returns one or more complete sentences, hand each to
     synthesize() -- ideally from a single background worker that processes
     sentences strictly in order, so playback ordering is never in question
     even though synthesis runs concurrently with ongoing text generation.
"""

import asyncio
import base64
import io
import re

VOICE = "bm_daniel"
LANG_CODE = "b"
SAMPLE_RATE = 24000

_pipeline = None


def load_model():
    """Load the Kokoro pipeline once at startup. Safe to call more than once."""
    global _pipeline
    if _pipeline is not None:
        return _pipeline

    from kokoro import KPipeline
    print("[KOKORO] Loading TTS pipeline...", flush=True)
    _pipeline = KPipeline(lang_code=LANG_CODE)

    # Warm up now (weights JIT/first-run cost, etc.) rather than paying this
    # latency on some user's first request -- same reasoning as loading the
    # Vosk model eagerly at startup instead of lazily on first use.
    try:
        list(_pipeline("Hello.", voice=VOICE))
    except Exception as e:
        print(f"[KOKORO] Warmup synthesis failed (continuing anyway): {e}", flush=True)

    print("[KOKORO] TTS pipeline loaded.", flush=True)
    return _pipeline


def is_ready() -> bool:
    return _pipeline is not None


def _synthesize_sync(text: str) -> str:
    """Blocking call -- only ever run this via asyncio.to_thread, never
    directly on the event loop. Returns base64-encoded WAV bytes, or ''
    if there was nothing audible to synthesize.

    NOTE: Kokoro's pipeline call signature has shifted across versions --
    this assumes `pipeline(text, voice=...)` yields (graphemes, phonemes,
    audio) tuples per chunk, matching current published examples. Verify
    against your installed `kokoro` version if this errors.
    """
    import numpy as np
    import soundfile as sf

    audio_chunks = [audio for _, _, audio in _pipeline(text, voice=VOICE)]
    if not audio_chunks:
        return ""

    full_audio = np.concatenate(audio_chunks)
    buf = io.BytesIO()
    sf.write(buf, full_audio, SAMPLE_RATE, format="WAV")
    return base64.b64encode(buf.getvalue()).decode("ascii")


async def synthesize(text: str) -> str:
    """Synthesize one chunk of text (ideally one sentence) to base64 WAV
    without blocking the event loop."""
    if not text.strip():
        return ""
    return await asyncio.to_thread(_synthesize_sync, text)


# ─── Sentence segmentation ──────────────────────────────────────────────────

_SENTENCE_END_RE = re.compile(r'(?<=[.!?])\s+')


class SentenceAccumulator:
    """Feed it streamed text tokens; returns any newly-completed sentences
    on each call. Whatever hasn't hit a sentence boundary yet stays
    buffered internally until either more tokens complete it, or flush()
    is called once generation has fully finished.

    Known limitation: doesn't special-case markdown code fences -- a code
    block in the response will get sentence-split and synthesized like
    prose rather than skipped. Fine for a first version; revisit if it
    turns out to matter in practice.
    """

    def __init__(self):
        self._buffer = ""

    def feed(self, token: str) -> list:
        self._buffer += token
        parts = _SENTENCE_END_RE.split(self._buffer)
        if len(parts) <= 1:
            return []
        complete, self._buffer = parts[:-1], parts[-1]
        return [s.strip() for s in complete if s.strip()]

    def flush(self) -> str:
        """Call once generation is done to get whatever's left over (e.g. a
        final sentence with no trailing punctuation)."""
        remaining = self._buffer.strip()
        self._buffer = ""
        return remaining