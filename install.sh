#!/usr/bin/env bash

# Ensure the script is run as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (sudo ./install.sh)"
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTUAL_USER=${SUDO_USER:-$USER}

echo "Installing backend daemon from $PROJECT_DIR..."
echo "Service will run under user: $ACTUAL_USER"

if [ ! -d "$PROJECT_DIR/.venv" ]; then
  echo "Creating Python virtual environment..."
  sudo -u "$ACTUAL_USER" python3 -m venv "$PROJECT_DIR/.venv"
fi

# 2. Install dependencies using your requirements.txt
echo "Installing/Updating dependencies from requirements.txt..."
sudo -u "$ACTUAL_USER" "$PROJECT_DIR/.venv/bin/pip" install --upgrade pip

if [ -f "$PROJECT_DIR/requirements.txt" ]; then
  sudo -u "$ACTUAL_USER" "$PROJECT_DIR/.venv/bin/pip" install -r "$PROJECT_DIR/requirements.txt"
else
  echo "⚠️ warning: requirements.txt not found! Installing baseline packages..."
  sudo -u "$ACTUAL_USER" "$PROJECT_DIR/.venv/bin/pip" install fastapi uvicorn ollama pydantic
fi

# Create the systemd service file dynamically
cat <<EOF > /etc/systemd/system/omnichat.service
[Unit]
Description=omnichat backend
After=network.target

[Service]
Type=simple
User=$ACTUAL_USER
WorkingDirectory=$PROJECT_DIR/backend
ExecStart=$PROJECT_DIR/.venv/bin/python $PROJECT_DIR/backend/main.py
Restart=on-failure
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd, enable and start the service
systemctl daemon-reload
systemctl enable omnichat.service
systemctl start omnichat.service

echo "Installation complete! Service is running."
echo "Check status using: systemctl status omnichat.service"