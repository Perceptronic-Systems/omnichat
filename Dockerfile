FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir --break-system-packages -r requirements.txt

COPY backend/ ./backend/

COPY backend/entrypoint.sh .
RUN chmod +x backend/entrypoint.sh

EXPOSE 5014

ENTRYPOINT ["./backend/entrypoint.sh"]