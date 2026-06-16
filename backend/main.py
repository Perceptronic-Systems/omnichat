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
                valid_files.append(file)

    if not sessions.get(id):
        sessions[id] = llm('Omnichat')
        
    model = sessions[id]
    
    stream = generator_wrapper(model, prompt, valid_files)
    response = StreamingResponse(stream, media_type='text/event-stream')
    return response

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=5014,
        reload=False
    )