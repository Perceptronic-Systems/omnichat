#!/bin/bash

ollama serve &

echo "Waiting for Ollama server to start..."
while ! curl -s http://127.0.0.1:11434/api/tags > /dev/null; do
    sleep 1
done

echo "Starting Omnichat backend..."
python backend/main.py