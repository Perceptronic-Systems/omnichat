from model_gateway import llm, initialize_tools
import fastapi
from fastapi import Response, FastAPI
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from pydantic import BaseModel
import json
import asyncio

app = FastAPI()
sessions = {}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"], 
    allow_headers=["*"],
)

class PromptStructure(BaseModel):
    prompt: str
    id: int

@asynccontextmanager
async def lifespan(app: FastAPI):
    await initialize_tools()
    yield

@app.get("/status")
def get_status():
    return "Running"

def generator_wrapper(model, prompt: str):
    stream = model.generate(prompt)
    for chunk in stream:
        yield 'data: ' + json.dumps(chunk) + ' \n\n'

@app.post("/generate")
def generate(content: PromptStructure):
    print('Fetching model...')
    if not sessions.get(content.id):
        sessions[content.id] = llm('gemma4:e2b', 'Omnichat')
    print(sessions)
    model = sessions[content.id]
    stream = generator_wrapper(model, content.prompt)
    response = StreamingResponse(stream, media_type='plain/text')
    return response


