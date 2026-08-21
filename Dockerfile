FROM python:3.11-slim
 
WORKDIR /app
 
COPY requirements.txt .
 
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --break-system-packages -r requirements.txt
 
COPY backend/ ./backend/
 
COPY backend/entrypoint.sh .
RUN chmod +x backend/entrypoint.sh
 
EXPOSE 5014
 
ENTRYPOINT ["./backend/entrypoint.sh"]
