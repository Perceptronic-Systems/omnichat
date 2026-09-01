#!/usr/bin/env python3

from model_gateway import llm, initialize_tools
import fastapi
from fastapi import Response, FastAPI, Form, UploadFile, File, WebSocket, WebSocketDisconnect, Request, Header, Depends, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from typing import List, Optional
import json
import asyncio
import uvicorn
import atexit
from fastapi.responses import StreamingResponse, JSONResponse
from mcp_server import (
    cleanup_all_containers,
    fm_list_directory,
    fm_read_file,
    fm_write_file,
    fm_delete_path,
    fm_make_directory,
)
import speech_to_text
import text_to_speech
import session_manager

atexit.register(cleanup_all_containers)

@asynccontextmanager
async def lifespan(app: FastAPI):
    await initialize_tools()
    try:
        speech_to_text.load_model()
    except Exception as e:
        # Voice input is a nice-to-have on top of an otherwise working app --
        # a bad/missing/corrupt Vosk model directory should never take down
        # text chat with it. speech_to_text.is_ready() will correctly report
        # False and /ws/transcribe will tell connecting clients voice isn't
        # available, instead of the whole process crash-looping.
        print(f"[VOSK] Failed to load model, voice input will be unavailable: {e}", flush=True)
    try:
        speech_to_text.load_final_pass_model()
    except Exception as e:
        # Additive on top of Vosk, not load-bearing -- TranscriptionSession
        # falls back to Vosk's own final result if this never loads.
        print(f"[WHISPER] Failed to load final-pass model, falling back to Vosk-only transcription: {e}", flush=True)
    try:
        text_to_speech.load_model()
    except Exception as e:
        # Same reasoning as above: TTS is additive, never load-bearing for
        # basic text chat.
        print(f"[KOKORO] Failed to load model, TTS will be unavailable: {e}", flush=True)
    yield
    
app = FastAPI(lifespan=lifespan)
sessions = {}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"], 
    allow_headers=["*"],
)

@app.get("/status")
def get_status():
    return "Running"


async def require_session(authorization: str = Header(None)) -> str:
    """FastAPI dependency for every endpoint that needs an authenticated
    session. Extracts a bearer token from the Authorization header and
    validates it against session_manager's own registry -- a token that
    was never actually issued by THIS server (made up, guessed, reused
    from somewhere else) is rejected outright, unlike the old scheme where
    any client-supplied integer worked simply by being used as a dict key."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header")
    token = authorization[len("Bearer "):].strip()
    if not session_manager.touch_and_validate(token):
        raise HTTPException(status_code=401, detail="Invalid or expired session token")
    return token


@app.post("/session/create")
async def create_session(request: Request):
    """Mints a new session token. The frontend calls this lazily, only at
    the moment of the first actual send (message, voice utterance, file
    operation) -- never on page load -- so a visitor who never interacts
    never costs the server a session or a sandbox container."""
    client_ip = session_manager.get_client_ip(request)
    token, error = session_manager.create_session(client_ip)
    if error == "rate_limited":
        return JSONResponse(status_code=429, content={"error": "Too many session attempts from this address. Please wait a moment and try again."})
    if error == "at_capacity":
        return JSONResponse(status_code=503, content={"error": "The server is at capacity right now. Please try again shortly."})
    return {"token": token}


@app.get("/voice/status")
def get_voice_status():
    return {
        "stt_ready": speech_to_text.is_ready(),
        "stt_final_pass_ready": speech_to_text.final_pass_ready(),
        "tts_ready": text_to_speech.is_ready(),
    }

@app.get("/files/list")
def list_container_files(path: str = "/", token: str = Depends(require_session)):
    result = fm_list_directory(token, path)
    if "error" in result:
        return JSONResponse(status_code=400, content=result)
    return result


@app.get("/files/read")
def read_container_file(path: str, token: str = Depends(require_session)):
    data, meta = fm_read_file(token, path)
    if data is None:
        return JSONResponse(status_code=404, content=meta)
    try:
        text = data.decode("utf-8")
        return {**meta, "binary": False, "content": text}
    except UnicodeDecodeError:
        return {**meta, "binary": True, "content": None}


@app.get("/files/download")
def download_container_file(path: str, token: str = Depends(require_session)):
    data, meta = fm_read_file(token, path, max_bytes=200_000_000)
    if data is None:
        return JSONResponse(status_code=404, content=meta)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{meta["name"]}"'},
    )


@app.post("/files/upload")
async def upload_container_file(path: str = Form(...), file: UploadFile = File(...), token: str = Depends(require_session)):
    content = await file.read()
    target = path.rstrip("/") + "/" + file.filename
    ok = fm_write_file(token, target, content)
    if not ok:
        return JSONResponse(status_code=500, content={"error": "Upload failed"})
    return {"success": True, "path": target}


@app.delete("/files/delete")
def delete_container_file(path: str, token: str = Depends(require_session)):
    result = fm_delete_path(token, path)
    if "error" in result:
        return JSONResponse(status_code=400, content=result)
    return result


@app.post("/files/mkdir")
def make_container_directory(path: str = Form(...), token: str = Depends(require_session)):
    result = fm_make_directory(token, path)
    if "error" in result:
        return JSONResponse(status_code=400, content=result)
    return result


@app.websocket("/ws/transcribe")
async def websocket_transcribe(websocket: WebSocket, token: str = None):
    await websocket.accept()

    # Browsers' native WebSocket API can't set custom headers, only what's
    # in the URL -- so unlike every other endpoint (Authorization header),
    # this one has to take the token as a query param. That does mean it
    # can end up in server access logs; worth excluding this path's query
    # string from nginx logging if that matters for your deployment.
    if not session_manager.touch_and_validate(token):
        await websocket.send_text(json.dumps({
            "type": "error",
            "message": "Missing or invalid session token."
        }))
        await websocket.close()
        return

    if not speech_to_text.is_ready():
        await websocket.send_text(json.dumps({
            "type": "error",
            "message": "Speech-to-text model is not loaded on the server."
        }))
        await websocket.close()
        return

    session = speech_to_text.TranscriptionSession()

    try:
        while True:
            message = await websocket.receive()

            if message["type"] == "websocket.disconnect":
                break

            audio_bytes = message.get("bytes")
            if audio_bytes is not None:
                result = session.accept_audio(audio_bytes)
                await websocket.send_text(json.dumps(result))
                continue

            text_frame = message.get("text")
            if text_frame is not None:
                try:
                    control = json.loads(text_frame)
                except (json.JSONDecodeError, TypeError):
                    continue
                if control.get("type") == "stop":
                    result = await session.finalize()
                    await websocket.send_text(json.dumps(result))
                    # Previously: `break` here, closing the connection after
                    # one utterance -- correct for push-to-talk (client
                    # reopens a fresh socket every press), but wrong for
                    # always-listening mode, where the client's VAD sends
                    # 'stop' automatically at each detected pause and wants
                    # to keep streaming audio for the *next* utterance on
                    # the same connection. A fresh session per utterance is
                    # still correct -- KaldiRecognizer's internal state
                    # shouldn't carry over -- so just swap in a new one and
                    # keep the loop going. Real disconnects are still
                    # handled by the websocket.disconnect branch above.
                    session = speech_to_text.TranscriptionSession()
                    continue
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[TRANSCRIBE ERROR] {e}")
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass

# How often to send an SSE keep-alive comment while we're waiting for the
# next real chunk from the model. This matters most on the *first* message
# to a given model, when Ollama has to load it into memory before emitting
# any tokens at all -- that can easily take longer than a typical reverse
# proxy's idle/read timeout (nginx defaults to 60s). Without a heartbeat,
# a proxy sitting in front of this server will silently end the connection
# while nothing has been sent yet, and the client sees a blank response
# with no error, even though FastAPI itself never crashed or timed out.
HEARTBEAT_INTERVAL_SECONDS = 15

_SENTINEL = object()


async def generator_wrapper(model, prompt: str, files: List[UploadFile], want_audio: bool = False):
    queue: asyncio.Queue = asyncio.Queue()

    async def producer():
        accumulator = None
        tts_queue = None
        tts_worker_task = None

        try:
            if want_audio and text_to_speech.is_ready():
                accumulator = text_to_speech.SentenceAccumulator()
                tts_queue = asyncio.Queue()
                print("[TTS] pipeline engaged for this request", flush=True)

                async def tts_worker():
                    # Strictly one sentence at a time, in submission order.
                    # This is what guarantees correct playback ordering --
                    # synthesis for sentence N still overlaps with the LLM
                    # generating sentence N+1's tokens (this worker and the
                    # text loop below run as separate concurrent tasks), but
                    # within the worker itself nothing runs out of order.
                    while True:
                        sentence = await tts_queue.get()
                        if sentence is None:
                            print("[TTS] worker received stop signal", flush=True)
                            break
                        print(f"[TTS] synthesizing: {sentence!r}", flush=True)
                        try:
                            audio_b64 = await text_to_speech.synthesize(sentence)
                            if audio_b64:
                                print(f"[TTS] synthesized {len(audio_b64)} b64 chars for: {sentence!r}", flush=True)
                                await queue.put({
                                    'status': 'Generating', 'token': '', 'tool_calls': [],
                                    'is_done': False, 'audio': audio_b64,
                                })
                                print("[TTS] audio chunk queued for delivery to client", flush=True)
                            else:
                                print(f"[TTS] synthesize() returned EMPTY for: {sentence!r}", flush=True)
                        except Exception as e:
                            print(f"[TTS ERROR] {e}", flush=True)

                tts_worker_task = asyncio.create_task(tts_worker())
            elif want_audio:
                print(f"[TTS] want_audio=True but is_ready()=False -- skipping TTS entirely for this request", flush=True)

            # The terminal chunk (is_done=True) is held back rather than
            # forwarded immediately. The client returns as soon as it sees
            # is_done, so if we sent it the moment text generation finishes,
            # any audio still pending -- most importantly the LAST sentence,
            # which only gets flushed into the TTS queue *after* this loop
            # ends -- would be sent after the client already stopped
            # listening and silently dropped. Only the final chunk actually
            # needs to wait; everything else still streams immediately.
            final_chunk = None

            async for chunk in model.generate(prompt, tts=want_audio, uploaded_files=files):
                if accumulator is not None and chunk.get('token'):
                    for sentence in accumulator.feed(chunk['token']):
                        print(f"[TTS] sentence boundary detected: {sentence!r}", flush=True)
                        await tts_queue.put(sentence)

                if chunk.get('is_done'):
                    final_chunk = chunk
                    continue
                await queue.put(chunk)

            if accumulator is not None:
                tail = accumulator.flush()
                if tail:
                    print(f"[TTS] flushing tail sentence: {tail!r}", flush=True)
                    await tts_queue.put(tail)

        except Exception as e:
            # Belt-and-suspenders: model_gateway already catches its own
            # errors and yields a terminal chunk, but if something upstream
            # of that still raises, make sure the client still gets a
            # visible message instead of a silently closed connection.
            print(f"[GENERATE ERROR] {e}")
            final_chunk = {
                'status': 'error',
                'token': f"\n\n*Internal error: {e}*",
                'tool_calls': [],
                'is_done': True,
            }
        finally:
            if tts_worker_task is not None:
                await tts_queue.put(None)  # tell the worker to stop...
                try:
                    await tts_worker_task  # ...and wait for the last sentence's audio
                except Exception as e:
                    print(f"[TTS ERROR] worker cleanup: {e}")
            # Only now, after every audio chunk has definitely been queued,
            # is it safe to send the chunk that tells the client to stop
            # listening.
            if final_chunk is not None:
                await queue.put(final_chunk)
            await queue.put(_SENTINEL)

    task = asyncio.create_task(producer())

    waited_seconds = 0
    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_INTERVAL_SECONDS)
            except asyncio.TimeoutError:
                # Send a real status update, not just a bare SSE comment.
                # This does double duty: it puts bytes on the wire so no
                # proxy/load balancer treats the connection as idle, AND it
                # updates the visible status text so the UI doesn't sit on
                # "Connecting" the entire time a model is loading. The first
                # request to a given model can take a while if Ollama has
                # to load (or pull) it before it can emit any tokens.
                waited_seconds += HEARTBEAT_INTERVAL_SECONDS
                status_msg = 'Thinking' if waited_seconds < 60 else 'Still working on a response (a cold model load or a long conversation history can both cause this)'
                yield 'data: ' + json.dumps({
                    'status': status_msg, 'token': '', 'tool_calls': [], 'is_done': False
                }) + ' \n\n'
                continue

            if item is _SENTINEL:
                break
            waited_seconds = 0
            yield 'data: ' + json.dumps(item) + ' \n\n'
    finally:
        if not task.done():
            task.cancel()

@app.post("/generate")
async def generate(
    prompt: str = Form(default=""),
    files: Optional[List[UploadFile]] = File(default=None),
    tts: bool = Form(default=False),
    token: str = Depends(require_session),
):
    print(f"Fetching model for session: {token[:8]}...")

    valid_files = []
    if files:
        for file in files:
            if file.filename != '':
                content = await file.read()
                valid_files.append((file.filename, content))

    if not sessions.get(token):
        sessions[token] = llm('Omnichat', session_id=token)

    model = sessions[token]

    stream = generator_wrapper(model, prompt, valid_files, want_audio=tts)
    response = StreamingResponse(
        stream,
        media_type='text/event-stream',
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"}
    )
    return response

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=5014,
        reload=False
    )