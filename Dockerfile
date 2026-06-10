FROM ollama/ollama:latest

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN ln -s /usr/bin/python3 /usr/bin/python

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir --break-system-packages -r requirements.txt

COPY backend/ ./backend/

COPY backend/entrypoint.sh .
RUN chmod +x backend/entrypoint.sh

EXPOSE 5014

ENTRYPOINT ["./entrypoint.sh"]