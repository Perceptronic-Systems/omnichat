import ollama
import numpy as np
import time
from typing import Dict, Any, Callable
import tools
import json
from flask import Flask, Response, request
from flask_cors import CORS
import tomllib
import os

llm_model = "gemma4:e4b"
api = "http://127.0.0.1:11434"

config_path = os.path.expanduser("~/.config/omnichat/config.toml")

if os.path.exists(config_path):
    with open(config_path, 'rb') as f:
        config = tomllib.load(f)
    try:
        llm_model = config['ollama']['model']
        api = config['ollama']['host_address']
    except Excpetion as e:
        print("Missing config attribute.")
        print(e)

print(f"Host API: {api}")
client = ollama.Client(host=api)

app = Flask(__name__)
CORS(app, resources={r"/generate": {"origins": "*"}})

class LLM():
    def __init__(self, model=llm_model, max_messages=12):
        self.model = model
        self.max_messages = max_messages
        self.messages = []
        self.call_index = 0
        self.available_tools: Dict[str, Callable] = {
            'search_for_file': tools.search_for_file,
            'list_files': tools.list_files,
            'read_file': tools.read_file,
            #'write_file': tools.write_file,
            'calculator': tools.calculator
            #'search_web': tools.search_web
        }
    
    def chat(self, username, user_input, think=False):
        self.messages.append({'role': 'user', 'content': f"(username: {username})\n{user_input}"})
        for chunk in self.run(think=think):
            yield chunk
    
    def run(self, think=False):
        timer = time.time()
        if len(self.messages) > self.max_messages:
            self.messages = self.messages[-self.max_messages:]
        tool_calling = True
        tool_options = self.available_tools
        response_content = ""
        status = "Generating"
        while tool_calling:
            response_stream = client.chat(model=self.model,
                                          messages=self.messages,
                                          tools=list(tool_options.values()),
                                          think=think,
                                          stream=True)
            fn_calls = []
            for chunk in response_stream:
                status = "Generating"
                answer_token = chunk['message'].get('content', '')
                response_content += answer_token
                thought_token = chunk['message'].get('thinking', '')
                if thought_token:
                    status = "Thinking"
                fn_call = chunk['message'].get('tool_calls', [])
                if fn_call:
                    fn_calls.extend(fn_call)
                    status = "Tool calling"
                    yield ([{"name": call.function.name, "arguments": call.function.arguments, "content": ""} for call in fn_call], thought_token, answer_token, status)
                else:
                    yield ([], thought_token, answer_token, status)
            tool_names = []
            tool_args = []
            for call in fn_calls:
                tool_names.append(call.function.name)
                tool_args.append(call.function.arguments)
            tool_outputs, expected_response = self.tool_calls(fn_calls, tool_options)
            if tool_outputs != []:
                for function_name, function_args, tool_output in zip(tool_names, tool_args, tool_outputs):
                    yield ([{"name": '', "arguments": '', "content": tool_output}], None, '', status)
                    tool_message = {'role': 'tool', 'name': function_name, 'content': tool_output}
                    self.messages = [m for m in self.messages if m != tool_message]
                    self.messages.append(tool_message)
                if expected_response == {}:
                    tool_options = self.available_tools
                else:
                    tool_options = expected_response
            else:
                tool_calling = False
        timer = time.time() - timer
        self.messages.append({'role': 'assistant', 'content': response_content})
    
    def tool_calls(self, tool_calls, available_tools):
        tool_outputs = []
        expected_output = {}
        if tool_calls:
            #tool_call_strings = []
            for tool in tool_calls:
                tool_name = tool.function.name
                tool_arguments = tool.function.arguments
                #tool_call_strings.append("[TOOL_CALL] {'name': " + tool_name + ", 'arguments': " + str(tool_arguments) + "}")
                if function_to_call := available_tools.get(tool_name):
                    tool_output, expected_response = function_to_call(**tool_arguments)
                    tool_output = f"{str(tool_arguments)}\n\n{tool_output}"
                    print(f"    [tool call: {tool_name}({tool_arguments})]")
                    tool_outputs.append(tool_output)
                    expected_output.update(expected_response)
                else:
                    print("Function", tool.function.name, 'not found')
                self.call_index += 1
            #self.messages.append({'role': 'assistant', 'content': '\n'.join(tool_call_strings)})
        return tool_outputs, expected_output


if __name__ == "__main__":
    model = LLM()
    conversations = {}
    last_used = {}

    @app.route('/generate', methods=['POST', 'OPTIONS'])
    async def generate():
        global conversations
        if request.method == 'OPTIONS':
            return '', 200

        body = request.get_json()
        prompt = body.get('prompt', '')
        conversation_id = body.get('id', '')
        if conversations != {}:
            temp_c = {}
            current_time = time.time()
            for id, c in list(conversations.items()):
                if id != conversation_id:
                    if c.get("last_used", 0.0) > (current_time - 14400):
                        temp_c[id] = c
                else:
                    temp_c[id] = c
            conversations = temp_c
        
        if prompt == '':
            return {"error": "Prompt is required"}, 400
        
        def generate_tokens():
            think = False
            user_input = prompt # For some reason it doesn't work if I use the `prompt`` variable directly, I still have a lot to learn I guess lol
            conversation = conversations.get(conversation_id, {"last_used": time.time(), "messages": []}).get("messages", [])
            model.messages = conversation
            if user_input.startswith("/think "):
                user_input = user_input.replace("/think ", "")
                think = True
            stream_response = model.chat("User", user_input, think=think)
            for chunk in stream_response:
                (tool_call_content, thought_token, answer_token, status) = chunk
                packet = {"tool_calls": tool_call_content, "thought_token": thought_token, "answer_token": answer_token, "status": status}
                yield str(json.dumps(packet))
            yield str(json.dumps({"tool_calls": "", "thought_token": "", "answer_token": "", "status": "finished"}))
            conversations[conversation_id] = {"last_used": time.time(), "messages": model.messages}
        return Response(generate_tokens(), content_type='text/event-stream')
    
    app.run(host='127.0.0.1', port=5014)