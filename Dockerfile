FROM python:3.11-slim

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# Pin this explicitly so build-time download and runtime lookup are
# guaranteed to agree on where the weights live, regardless of what the
# base image's default HOME/cache resolution would otherwise pick.
ENV HF_HOME=/root/.cache/huggingface

COPY requirements.txt .

RUN uv pip install --system --no-cache -r requirements.txt

RUN python3 -c "from kokoro import KPipeline; p = KPipeline(lang_code='b'); list(p('Hello.', voice='bm_daniel'))"
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"

COPY backend/ ./backend/

COPY backend/entrypoint.sh .
RUN chmod +x backend/entrypoint.sh

EXPOSE 5014

ENTRYPOINT ["./backend/entrypoint.sh"]