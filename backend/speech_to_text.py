#!/usr/bin/env python3
"""Vosk-based streaming speech-to-text.

One TranscriptionSession is created per WebSocket connection in main.py's
/ws/transcribe route. The Vosk Model itself is loaded once at startup and
shared read-only across sessions -- only the KaldiRecognizer (which holds
decoder state) is per-session.
"""

import os
import json
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


class TranscriptionSession:
    """Wraps one KaldiRecognizer for the lifetime of a single WebSocket
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
        if self.recognizer.AcceptWaveform(pcm16_bytes):
            result = json.loads(self.recognizer.Result())
            segment_text = result.get("text", "")
            if segment_text:
                self._finalized_segments.append(segment_text)
            return {"type": "partial", "text": self._full_text()}
        else:
            partial = json.loads(self.recognizer.PartialResult())
            return {"type": "partial", "text": self._full_text(partial.get("partial", ""))}

    def finalize(self) -> dict:
        result = json.loads(self.recognizer.FinalResult())
        trailing_text = result.get("text", "")
        if trailing_text:
            self._finalized_segments.append(trailing_text)
        return {"type": "final", "text": self._full_text()}