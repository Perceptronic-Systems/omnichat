#!/usr/bin/env python3

from model_gateway import llm, initialize_tools
import fastapi
from fastapi import Response, FastAPI, Form, UploadFile, File
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
    cleanup_container,
    fm_list_directory,
    fm_read_file,
    fm_write_file,
    fm_delete_path,
    fm_make_directory,
)

atexit.register(cleanup_container)

@asynccontextmanager
async def lifespan(app: FastAPI):
    await initialize_tools()
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

@app.get("/files/list")
def list_container_files(path: str = "/"):
    result = fm_list_directory(path)
    if "error" in result:
        return JSONResponse(status_code=400, content=result)
    return result


@app.get("/files/read")
def read_container_file(path: str):
    data, meta = fm_read_file(path)
    if data is None:
        return JSONResponse(status_code=404, content=meta)
    try:
        text = data.decode("utf-8")
        return {**meta, "binary": False, "content": text}
    except UnicodeDecodeError:
        return {**meta, "binary": True, "content": None}


@app.get("/files/download")
def download_container_file(path: str):
    data, meta = fm_read_file(path, max_bytes=200_000_000)
    if data is None:
        return JSONResponse(status_code=404, content=meta)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{meta["name"]}"'},
    )


@app.post("/files/upload")
async def upload_container_file(path: str = Form(...), file: UploadFile = File(...)):
    content = await file.read()
    target = path.rstrip("/") + "/" + file.filename
    ok = fm_write_file(target, content)
    if not ok:
        return JSONResponse(status_code=500, content={"error": "Upload failed"})
    return {"success": True, "path": target}


@app.delete("/files/delete")
def delete_container_file(path: str):
    result = fm_delete_path(path)
    if "error" in result:
        return JSONResponse(status_code=400, content=result)
    return result


@app.post("/files/mkdir")
def make_container_directory(path: str = Form(...)):
    result = fm_make_directory(path)
    if "error" in result:
        return JSONResponse(status_code=400, content=result)
    return result

def generator_wrapper(model, prompt: str, files: List[UploadFile]):
    # We pass raw fields downwards to the model wrapper
    stream = model.generate(prompt, files)
    for chunk in stream:
        yield 'data: ' + json.dumps(chunk) + ' \n\n'

@app.post("/generate")
async def generate(
    id: int = Form(...),
    prompt: str = Form(default=""),
    files: Optional[List[UploadFile]] = File(default=None)
):
    print(f"Fetching model for session: {id}...")

    valid_files = []
    if files:
        for file in files:
            if file.filename != '':
                # Read the bytes NOW, while the request/UploadFile is still alive
                content = await file.read()
                valid_files.append((file.filename, content))

    if not sessions.get(id):
        sessions[id] = llm('Omnichat')

    model = sessions[id]

    stream = generator_wrapper(model, prompt, valid_files)
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