#!/usr/bin/env python3
"""Speech-to-text: Vosk for live streaming partials, faster-whisper for a
more accurate final pass once the user stops talking.

One TranscriptionSession is created per WebSocket connection in main.py's
/ws/transcribe route. Both models are loaded once at startup and shared
read-only across sessions -- only the KaldiRecognizer (which holds decoder
state) and the raw-audio buffer are per-session.

Design: Vosk's live partial-result path is completely untouched -- it's
fast and that's what matters while the user is actively speaking. On
finalize(), IF faster-whisper loaded successfully, the entire buffered
utterance gets re-transcribed with it and that becomes the authoritative
final text (what actually reaches the LLM). If faster-whisper isn't
available or fails for any reason, Vosk's own final result is used as a
fallback instead -- same "additive, never load-bearing" resilience pattern
as everywhere else in this app.
"""

import os
import json
import asyncio
import vosk

vosk.SetLogLevel(-1)  # silence Vosk's own C++-level logging spam

VOSK_MODEL_PATH = os.getenv("VOSK_MODEL_PATH", "/models/vosk-model-small-en-us-0.15")
SAMPLE_RATE = 16000

_model = None


def load_model():
    """Load the Vosk model once at startup. Safe to call more than once."""
    global _model
    if _model is not None:
        return _model
    if not os.path.isdir(VOSK_MODEL_PATH):
        print(f"[VOSK] Model directory not found at {VOSK_MODEL_PATH} -- voice input will be unavailable.", flush=True)
        return None
    print(f"[VOSK] Loading model from {VOSK_MODEL_PATH}...", flush=True)
    _model = vosk.Model(VOSK_MODEL_PATH)
    print("[VOSK] Model loaded.", flush=True)
    return _model


def is_ready() -> bool:
    return _model is not None


# ─── faster-whisper final-pass model ───────────────────────────────────────

FASTER_WHISPER_MODEL_SIZE = os.getenv("FASTER_WHISPER_MODEL_SIZE", "small")
FASTER_WHISPER_DEVICE = os.getenv("FASTER_WHISPER_DEVICE", "cpu")
FASTER_WHISPER_COMPUTE_TYPE = os.getenv("FASTER_WHISPER_COMPUTE_TYPE", "int8")

_whisper_model = None


def load_final_pass_model():
    """Load the faster-whisper model once at startup. Safe to call more
    than once. Non-fatal by design -- callers should wrap this the same
    way main.py already wraps load_model()/text_to_speech.load_model()."""
    global _whisper_model
    if _whisper_model is not None:
        return _whisper_model

    from faster_whisper import WhisperModel
    import numpy as np

    print(
        f"[WHISPER] Loading faster-whisper '{FASTER_WHISPER_MODEL_SIZE}' "
        f"(device={FASTER_WHISPER_DEVICE}, compute_type={FASTER_WHISPER_COMPUTE_TYPE})...",
        flush=True,
    )
    _whisper_model = WhisperModel(
        FASTER_WHISPER_MODEL_SIZE,
        device=FASTER_WHISPER_DEVICE,
        compute_type=FASTER_WHISPER_COMPUTE_TYPE,
    )

    # Warm up now rather than on some user's first finalized utterance --
    # same reasoning as the Vosk/Kokoro warmup elsewhere in this app.
    try:
        silence = np.zeros(SAMPLE_RATE, dtype=np.float32)  # 1s of silence
        segments, _ = _whisper_model.transcribe(silence, language="en")
        list(segments)
    except Exception as e:
        print(f"[WHISPER] Warmup failed (continuing anyway): {e}", flush=True)

    print("[WHISPER] faster-whisper model loaded.", flush=True)
    return _whisper_model


def final_pass_ready() -> bool:
    return _whisper_model is not None


def _transcribe_final_sync(pcm16_bytes: bytes) -> str:
    """Blocking call -- only ever run via asyncio.to_thread."""
    import numpy as np

    audio_i16 = np.frombuffer(pcm16_bytes, dtype=np.int16)
    audio_f32 = audio_i16.astype(np.float32) / 32768.0

    segments, _ = _whisper_model.transcribe(
        audio_f32,
        language="en",
        beam_size=5,
        # Whisper-family models are notorious for hallucinating stock
        # phrases ("Thanks for watching!", "Subscribe...") on silent or
        # near-silent audio -- trained heavily on captioned video, they'll
        # confidently produce *something* rather than correctly saying
        # nothing was said. vad_filter runs a lightweight Silero VAD pass
        # internally and strips silence before transcription, which is the
        # standard fix for this specific failure mode.
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
    )

    kept = []
    for seg in segments:
        # Extra safety net on top of vad_filter: no_speech_prob is the
        # model's own estimate that a segment contains no real speech.
        # High no_speech_prob combined with low avg_logprob (i.e. the model
        # wasn't confident either) is the classic signature of a
        # hallucinated segment slipping through -- drop those rather than
        # risk sending fabricated text to the LLM as if the user said it.
        if getattr(seg, 'no_speech_prob', 0) > 0.6 and getattr(seg, 'avg_logprob', 0) < -0.5:
            continue
        text = seg.text.strip()
        if text:
            kept.append(text)

    return " ".join(kept).strip()


async def transcribe_final(pcm16_bytes: bytes) -> str:
    """Re-transcribe a complete utterance with faster-whisper, without
    blocking the event loop."""
    if not pcm16_bytes:
        return ""
    return await asyncio.to_thread(_transcribe_final_sync, pcm16_bytes)


# ─── Per-connection session ─────────────────────────────────────────────────

class TranscriptionSession:
    """Wraps one KaldiRecognizer (plus a raw-audio buffer for the optional
    faster-whisper final pass) for the lifetime of a single WebSocket
    connection. Not safe to share across connections/users -- each instance
    holds its own decoder state and must not be reused after finalize()."""

    def __init__(self):
        if _model is None:
            raise RuntimeError("Vosk model is not loaded")
        self.recognizer = vosk.KaldiRecognizer(_model, SAMPLE_RATE)
        # KaldiRecognizer decides on its own when a pause is long enough to
        # count as the end of an "utterance" -- when that happens,
        # AcceptWaveform() returns True, Result() hands back that segment's
        # text, and the recognizer resets to a fresh segment internally.
        # Without tracking previously finalized segments ourselves, every
        # pause in speech would silently drop everything said before it,
        # since Result()/PartialResult() only ever describe the *current*
        # segment. This list is what makes multi-segment (i.e. any speech
        # with a pause in it) transcription actually accumulate.
        self._finalized_segments = []
        # Raw audio for the final-pass model. Vosk only ever sees this
        # through AcceptWaveform() and doesn't retain it -- we keep our own
        # copy so faster-whisper can re-transcribe the whole utterance once
        # recording stops, entirely independent of Vosk's own state.
        self._raw_audio_chunks = []

    def _full_text(self, in_progress: str = "") -> str:
        parts = [s for s in self._finalized_segments if s]
        if in_progress:
            parts.append(in_progress)
        return " ".join(parts)

    def accept_audio(self, pcm16_bytes: bytes) -> dict:
        """Feed one chunk of raw PCM16 mono 16kHz audio. Returns a dict to
        send straight to the client as a 'partial' message, always containing
        the FULL transcript so far (all previously finalized segments plus
        whatever's currently in progress) -- never just the current segment
        in isolation."""
        self._raw_audio_chunks.append(pcm16_bytes)

        if self.recognizer.AcceptWaveform(pcm16_bytes):
            result = json.loads(self.recognizer.Result())
            segment_text = result.get("text", "")
            if segment_text:
                self._finalized_segments.append(segment_text)
            return {"type": "partial", "text": self._full_text()}
        else:
            partial = json.loads(self.recognizer.PartialResult())
            return {"type": "partial", "text": self._full_text(partial.get("partial", ""))}

    async def finalize(self) -> dict:
        # Vosk's own final segment -- always computed, used both as the
        # fallback if the final-pass model isn't available/fails, AND as a
        # sanity gate before even attempting the whisper pass (see below).
        result = json.loads(self.recognizer.FinalResult())
        trailing_text = result.get("text", "")
        if trailing_text:
            self._finalized_segments.append(trailing_text)
        vosk_text = self._full_text()

        # If Vosk heard nothing at all, this utterance was very likely a
        # false VAD trigger (background noise, a bump, etc.) rather than
        # actual speech. Vosk doesn't share Whisper's tendency to
        # hallucinate stock phrases on silence -- it just reports nothing
        # heard -- so trust that signal and skip the (slower, more
        # hallucination-prone) whisper pass entirely rather than risk it
        # inventing text for audio nobody actually spoke over.
        if final_pass_ready() and vosk_text:
            full_audio = b"".join(self._raw_audio_chunks)
            try:
                whisper_text = await transcribe_final(full_audio)
                if whisper_text:
                    return {"type": "final", "text": whisper_text}
            except Exception as e:
                print(f"[WHISPER] Final-pass transcription failed, falling back to Vosk: {e}", flush=True)

        return {"type": "final", "text": vosk_text}