#!/usr/bin/env python3

import ollama
import tomllib
import os
import io
import asyncio
from pypdf import PdfReader
from typing import List
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
    def __init__(self, name, model=llm_model, prompt=default_prompt, max_messages=16):
        self.model = model
        self.name = name
        self.prompt = default_prompt
        self.max_messages = max_messages
        self.messages = [{"role": "system", "content": prompt}]
        self.status = 'idle'
        # Crucial fix: Initialize the AsyncClient scoped inside the instance/event loop
        self.client = ollama.AsyncClient(host=api)

    async def generate(self, user_prompt: str, uploaded_files: List[tuple] = None):
        uploaded_files = uploaded_files or []

        if user_prompt != '' or uploaded_files:
            message_payload = {'role': 'user', 'content': ""}
            images_payload = []

            for filename, file_bytes in uploaded_files:
                filename_lower = filename.lower()

                if filename_lower.endswith(('.png', '.jpg', '.jpeg', '.webp')):
                    images_payload.append(file_bytes)

                elif filename_lower.endswith(('.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac')):
                    images_payload.append(file_bytes)

                elif filename_lower.endswith('.pdf'):
                    try:
                        pdf_stream = io.BytesIO(file_bytes)
                        pdf_reader = PdfReader(pdf_stream)
                        pdf_text = ""
                        for page in pdf_reader.pages:
                            text = page.extract_text()
                            if text:
                                pdf_text += text + "\n"
                        if pdf_text.strip():
                            message_payload['content'] += f"\n\n[Attached PDF Content - {filename}]:\n{pdf_text}"
                        else:
                            message_payload['content'] += f"\n\n[Attached PDF: {filename} (No readable text found, it might be a scanned image)]"
                    except Exception as e:
                        print(f"Error parsing PDF {filename}: {e}")
                        message_payload['content'] += f"\n\n[Attached File: {filename} (Could not parse PDF text contents)]"

                else:
                    try:
                        text_content = file_bytes.decode('utf-8')
                        message_payload['content'] += f"\n\n[Attached File Context - {filename}]:\n{text_content}"
                    except Exception as e:
                        message_payload['content'] += f"\n\n[Attached File: {filename} (Could not parse text)]"

            if images_payload:
                message_payload['images'] = images_payload

            message_payload['content'] += f"\n\n{user_prompt}"

            self.messages.append(message_payload)

        status = 'Loading model'
        print(status)

        # Correct async call on instance client
        stream = await self.client.chat(
            model=self.model,
            messages=self.messages,
            tools=tools_list,
            stream=True,
            options={"num_ctx": 32768}
        )
        
        full_response = {'role': 'assistant', 'content': '', 'tool_calls': []}
        
        # Async stream loop processing
        async for chunk in stream:
            if status == "Loading model":
                print("Generating")
            status = 'Generating'
            delta = chunk.message
            if delta.content:
                full_response['content'] += delta.content
                if delta.tool_calls:
                    status = 'Using tools'
                yield {'status': status, 'token': delta.content, 'tool_calls': [], 'is_done': False}
            if delta.tool_calls:
                status = 'Using tools'
                for t in delta.tool_calls:
                    tool_call = {'function': {'name': t.function.name, 'arguments': t.function.arguments}}
                    full_response['tool_calls'].append(tool_call)
                    
                yield {'status': status, 'token': '', 'tool_calls': tool_call, 'is_done': False}

        if full_response['tool_calls'] or full_response['content'] == '':
            formatted_tool_calls = []
            for t in full_response['tool_calls']:
                formatted_tool_calls.append(ollama.Message.ToolCall(function={
                        'name': t['function']['name'],
                        'arguments': t['function']['arguments']
                    }))
            print("     recursion")
            self.messages.append({
                'role': 'assistant',
                'content': full_response['content'],
                'tool_calls': formatted_tool_calls})

            for tool_call in formatted_tool_calls:
                tool_name = tool_call.function.name
                tool_args = tool_call.function.arguments
                print(f"    [TOOL_CALL] {tool_name}({tool_args})")

                try:
                    tool_output = available_tools[tool_name](**tool_args)
                except Exception as e:
                    tool_output = f"Error executing tool: {e}"
                    print(f'Error, could not execute tool "{tool_name}" with arguments "{tool_args}"')
                    print(e)

                self.messages.append({'role': 'tool', 'content': str(tool_output)})

            # Yield from recursive step cleanly for async generators
            async for item in self.generate(''):
                yield item
        else:
            print(f"AI Response: {full_response['content']}")
            self.messages.append({
                'role': 'assistant',
                'content': full_response['content']
            })
            status = "idle"
            print("Done!")
            yield {'status': status, 'token': '', 'tool_calls': [], 'is_done': True}