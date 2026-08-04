#!/usr/bin/env python3

import ollama
from google import genai
from google.genai import types
import tomllib
import os
import io
import asyncio
from pypdf import PdfReader
from typing import List, AsyncGenerator, Dict, Any
from fastapi import UploadFile

import mcp_server as mcp

llm_model = "gemma4:e4b"
default_api = os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434")
api = default_api

bot_name = "Omnichat"

default_prompt = f"""You are {bot_name}, a helpful and autonomous assistant/agent. You must always maintain the persona of {bot_name}; never refer to yourself as Gemma, an AI, or a large language model.

CRITICAL INSTRUCTIONS:
1. IDENTITY: Your name is {bot_name}. If asked for your name or identity, you are {bot_name}.
2. BREVITY: Be direct, be concise. Do not include irrelevant or unnecessary information.
3. ACCURACY: Provide correct information. Do not leave out crucial information required to accurately answer the user.
4. FORMATTING: Always respond in Markdown format. Put any code references in code quotes or code blocks. As your input you may recieve multi-modal inputs, including but not limited to text, files, images, frame-sequences, and audio.

EXTERNAL TOOLS:
If the user asks for up-to-date, personal, or tool-specific information, you must generate tool calls to retrieve it. You have access to the user's personal files via the sandbox's persistant linked volume at `/etc/omnichat_knowledge_base/`
Always search the web when the user asks about specific or up to date information. You may generate multiple consecutive web searches in order to aquire the relevant information needed.
Always specify the year (2026) when searching the web for up to date information.
If you need to execute code, test scripts, manage files, or run system utilities, you have access to a full, sandboxed Linux terminal via the `execute_bash` tool. 
Always list or verify directory contents when working with file paths inside the Linux shell.
You may make multiple consecutive tool calls as many times as you need in order to achieve the task at hand. At times it may be needed to generate multiple consecutive tool calls in order to properly answer the user's message.

Do whatever the user tells you to."""

tools_list = []
available_tools = {}

async def initialize_tools():
    global tools_list, available_tools
    tools_list, available_tools = await mcp.initialize_tools()


config_path = os.path.expanduser("/etc/omnichat/config.toml")

if os.path.exists(config_path):
    with open(config_path, 'rb') as f:
        config = tomllib.load(f)
    try:
        llm_model = config['ollama']['model']
        api = config['ollama']['host_address']
    except Exception as e:
        print("Missing config attribute.")
        print(e)

print(f"Ollama Server API: {api}")


class llm():
    def __init__(self, name: str, model: str = llm_model, prompt: str = default_prompt, max_messages: int = 16):
        self.model = model
        self.name = name
        self.prompt = prompt
        self.max_messages = max_messages
        self.status = 'idle'

        self.use_google = False;

        self.ollama_messages = [{"role": "system", "content": self.prompt}]
        self.gemini_contents = []

        self.local_client = ollama.AsyncClient(host=api)
        self.google_client = genai.Client()  # Uses GEMINI_API_KEY env var

    async def generate(self, user_prompt: str, uploaded_files: List[tuple] = None) -> AsyncGenerator[Dict[str, Any], None]:
        if self.use_google:
            async for chunk in self._generate_gemini(user_prompt, uploaded_files):
                yield chunk
        else:
            async for chunk in self._generate_ollama(user_prompt, uploaded_files):
                yield chunk

    # -------------------------------------------------------------------------
    # GOOGLE GEMINI GENERATOR
    # -------------------------------------------------------------------------
    async def _generate_gemini(self, user_prompt: str, uploaded_files: List[tuple] = None) -> AsyncGenerator[Dict[str, Any], None]:
        uploaded_files = uploaded_files or []

        if user_prompt != '' or uploaded_files:
            content_parts = []

            # 1. Process attachments for Gemini
            for filename, file_bytes in uploaded_files:
                filename_lower = filename.lower()

                if filename_lower.endswith(('.png', '.jpg', '.jpeg', '.webp')):
                    mime = f"image/{filename_lower.split('.')[-1]}"
                    if mime == "image/jpg": mime = "image/jpeg"
                    content_parts.append(types.Part.from_bytes(data=file_bytes, mime_type=mime))

                elif filename_lower.endswith('.pdf'):
                    content_parts.append(types.Part.from_bytes(data=file_bytes, mime_type="application/pdf"))

                else:
                    try:
                        text_content = file_bytes.decode('utf-8')
                        content_parts.append(types.Part.from_text(text=f"[Attached File - {filename}]:\n{text_content}"))
                    except Exception:
                        content_parts.append(types.Part.from_text(text=f"[Attached File: {filename} (Could not parse text)]"))

            if user_prompt:
                content_parts.append(types.Part.from_text(text=user_prompt))

            self.gemini_contents.append(types.Content(role="user", parts=content_parts))

        # 2. Convert Python tools into functions Gemini can execute
        gemini_tools = list(available_tools.values()) if available_tools else None

        config = types.GenerateContentConfig(
            system_instruction=self.prompt,
            temperature=0.7,
            tools=gemini_tools,
        )

        status = 'Generating'
        full_text = ""
        detected_tool_calls = []

        # 3. Stream from Google Async API
        response_stream = await self.google_client.aio.models.generate_content_stream(
            model="gemini-3.6-flash",
            contents=self.gemini_contents,
            config=config
        )

        async for chunk in response_stream:
            if chunk.text:
                full_text += chunk.text
                yield {'status': status, 'token': chunk.text, 'tool_calls': [], 'is_done': False}

            # Capture tool execution requests
            if chunk.function_calls:
                for call in chunk.function_calls:
                    detected_tool_calls.append(call)
                    yield {
                        'status': 'Using tools',
                        'token': '',
                        'tool_calls': {'function': {'name': call.name, 'arguments': call.args}},
                        'is_done': False
                    }

        # 4. Handle tool execution recursive step
        if detected_tool_calls:
            # Store the assistant model function_call in context history
            self.gemini_contents.append(chunk.candidates[0].content)

            tool_response_parts = []
            for call in detected_tool_calls:
                fn_name = call.name
                fn_args = call.args if isinstance(call.args, dict) else {}
                print(f"    [GEMINI TOOL_CALL] {fn_name}({fn_args})")

                try:
                    tool_output = available_tools[fn_name](**fn_args)
                except Exception as e:
                    tool_output = f"Error executing tool: {e}"
                    print(f'Error executing tool "{fn_name}": {e}')

                # Add result back in Gemini format
                tool_response_parts.append(
                    types.Part.from_function_response(
                        name=fn_name,
                        response={"result": str(tool_output)}
                    )
                )

            # Push tool results to history
            self.gemini_contents.append(types.Content(role="user", parts=tool_response_parts))

            # Recursively pass context back to Gemini
            async for item in self.generate(''):
                yield item
        else:
            if full_text:
                self.gemini_contents.append(types.Content(role="model", parts=[types.Part.from_text(text=full_text)]))
            yield {'status': 'idle', 'token': '', 'tool_calls': [], 'is_done': True}

    # -------------------------------------------------------------------------
    # OLLAMA GENERATOR
    # -------------------------------------------------------------------------
    async def _generate_ollama(self, user_prompt: str, uploaded_files: List[tuple] = None) -> AsyncGenerator[Dict[str, Any], None]:
        uploaded_files = uploaded_files or []

        if user_prompt != '' or uploaded_files:
            message_payload = {'role': 'user', 'content': ""}
            images_payload = []

            for filename, file_bytes in uploaded_files:
                filename_lower = filename.lower()
                if filename_lower.endswith(('.png', '.jpg', '.jpeg', '.webp')):
                    images_payload.append(file_bytes)
                elif filename_lower.endswith('.pdf'):
                    try:
                        pdf_stream = io.BytesIO(file_bytes)
                        pdf_reader = PdfReader(pdf_stream)
                        pdf_text = "\n".join([p.extract_text() for p in pdf_reader.pages if p.extract_text()])
                        message_payload['content'] += f"\n\n[Attached PDF Content - {filename}]:\n{pdf_text}"
                    except Exception as e:
                        message_payload['content'] += f"\n\n[Attached File: {filename} (Error parsing PDF)]"
                else:
                    try:
                        message_payload['content'] += f"\n\n[Attached File Context - {filename}]:\n{file_bytes.decode('utf-8')}"
                    except Exception:
                        message_payload['content'] += f"\n\n[Attached File: {filename} (Could not parse text)]"

            if images_payload:
                message_payload['images'] = images_payload

            message_payload['content'] += f"\n\n{user_prompt}"
            self.ollama_messages.append(message_payload)

        status = 'Loading model'
        stream = await self.local_client.chat(
            model=self.model,
            messages=self.ollama_messages,
            tools=tools_list,
            stream=True,
            options={"num_ctx": 32768}
        )

        full_response = {'role': 'assistant', 'content': '', 'tool_calls': []}

        async for chunk in stream:
            status = 'Generating'
            delta = chunk.message
            if delta.content:
                full_response['content'] += delta.content
                yield {'status': status, 'token': delta.content, 'tool_calls': [], 'is_done': False}

            if delta.tool_calls:
                status = 'Using tools'
                for t in delta.tool_calls:
                    tool_call = {'function': {'name': t.function.name, 'arguments': t.function.arguments}}
                    full_response['tool_calls'].append(tool_call)
                    yield {'status': status, 'token': '', 'tool_calls': tool_call, 'is_done': False}

        if full_response['tool_calls']:
            formatted_tool_calls = []
            for t in full_response['tool_calls']:
                formatted_tool_calls.append(ollama.Message.ToolCall(function={
                    'name': t['function']['name'],
                    'arguments': t['function']['arguments']
                }))

            self.ollama_messages.append({
                'role': 'assistant',
                'content': full_response['content'],
                'tool_calls': formatted_tool_calls
            })

            for tool_call in formatted_tool_calls:
                tool_name = tool_call.function.name
                tool_args = tool_call.function.arguments
                print(f"    [OLLAMA TOOL_CALL] {tool_name}({tool_args})")

                try:
                    tool_output = available_tools[tool_name](**tool_args)
                except Exception as e:
                    tool_output = f"Error executing tool: {e}"
                    print(f'Error executing tool "{tool_name}": {e}')

                self.ollama_messages.append({'role': 'tool', 'content': str(tool_output)})

            # Recursive step for Ollama tool evaluation
            async for item in self.generate(''):
                yield item
        else:
            self.ollama_messages.append({
                'role': 'assistant',
                'content': full_response['content']
            })
            yield {'status': 'idle', 'token': '', 'tool_calls': [], 'is_done': True}