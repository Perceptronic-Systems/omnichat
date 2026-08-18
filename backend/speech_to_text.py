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

    def accept_audio(self, pcm16_bytes: bytes) -> dict:
        """Feed one chunk of raw PCM16 mono 16kHz audio. Returns a dict to
        send straight to the client as the 'partial' message -- Vosk calls
        a result "final" internally when it detects an utterance boundary
        mid-stream, but we still label it 'partial' to the client since the
        user hasn't released the mic yet; only finalize() below produces
        our 'final' message."""
        if self.recognizer.AcceptWaveform(pcm16_bytes):
            result = json.loads(self.recognizer.Result())
            return {"type": "partial", "text": result.get("text", "")}
        else:
            result = json.loads(self.recognizer.PartialResult())
            return {"type": "partial", "text": result.get("partial", "")}

    def finalize(self) -> dict:
        result = json.loads(self.recognizer.FinalResult())
        return {"type": "final", "text": result.get("text", "")}