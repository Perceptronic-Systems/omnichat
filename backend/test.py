#!/usr/bin/env python3
"""
Quick manual test for the TTS pipeline -- no frontend required.

Usage:
    pip install requests --break-system-packages   # if not already installed
    python3 test_tts.py "https://your-server/api/" "Tell me a short story about a cat."

Prints the streamed text live, and saves each sentence's synthesized audio
as sentence_001.wav, sentence_002.wav, etc. in the current directory so you
can play them back and actually judge latency/quality.
"""

import sys
import json
import base64
import requests

def main():
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <api_base_url> <prompt>")
        print(f'Example: {sys.argv[0]} https://starshipenterprise.dojo-flops.ts.net/api/ "Tell me a joke"')
        sys.exit(1)

    api_base = sys.argv[1]
    if not api_base.endswith("/"):
        api_base += "/"
    prompt = sys.argv[2]

    resp = requests.post(
        f"{api_base}generate",
        data={"id": "999999", "prompt": prompt, "tts": "true"},
        files={"files": ("", b"")},  # match the empty-file placeholder the JS client sends
        stream=True,
    )
    resp.raise_for_status()

    print("--- streaming response ---")
    audio_count = 0
    buf = ""

    for raw_line in resp.iter_lines(decode_unicode=True):
        if raw_line is None:
            continue
        buf += raw_line + "\n"
        if not buf.endswith("\n\n") and raw_line != "":
            continue

        for line in buf.strip("\n").split("\n"):
            line = line.strip()
            if not line.startswith("data:"):
                continue
            payload = line[len("data:"):].strip()
            try:
                chunk = json.loads(payload)
            except json.JSONDecodeError:
                continue

            if chunk.get("token"):
                print(chunk["token"], end="", flush=True)

            if chunk.get("audio"):
                audio_count += 1
                out_path = f"sentence_{audio_count:03d}.wav"
                with open(out_path, "wb") as f:
                    f.write(base64.b64decode(chunk["audio"]))
                print(f"\n[audio saved: {out_path}]", flush=True)

            if chunk.get("is_done"):
                print("\n--- done ---")

        buf = ""

    print(f"\nSaved {audio_count} audio file(s) in the current directory.")

if __name__ == "__main__":
    main()