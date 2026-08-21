FROM python:3.11-slim

WORKDIR /app

# Pin this explicitly so build-time download and runtime lookup are
# guaranteed to agree on where the weights live, regardless of what the
# base image's default HOME/cache resolution would otherwise pick.
ENV HF_HOME=/root/.cache/huggingface

COPY requirements.txt .

# Deliberately plain pip install with no BuildKit-specific syntax (no
# --mount=type=cache). This layer is still only re-run when requirements.txt
# itself changes -- that's ordinary Docker layer caching, not a BuildKit
# feature, and it's what actually solves "every code edit reinstalls
# everything." --no-cache-dir avoids leaving pip's own internal download
# cache baked uselessly into this layer, since without a persistent mount
# it can't help future builds anyway.
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt

# Pre-download the Kokoro TTS weights at build time, treated the same as
# any other dependency install rather than lazily on first app startup.
# This bakes a few hundred MB into the image, but means: (a) container
# startup never silently blocks on a network download while appearing
# "up" to nginx/docker, and (b) a download failure shows up as a normal
# build error right here, not as a confusing runtime state days later.
# NOTE: voice/lang_code here must stay in sync with VOICE/LANG_CODE in
# backend/text_to_speech.py.
RUN python3 -c "from kokoro import KPipeline; p = KPipeline(lang_code='b'); list(p('Hello.', voice='bm_daniel'))"

COPY backend/ ./backend/

COPY backend/entrypoint.sh .
RUN chmod +x backend/entrypoint.sh

EXPOSE 5014

ENTRYPOINT ["./backend/entrypoint.sh"]