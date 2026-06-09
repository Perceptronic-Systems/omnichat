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

# Create the systemd service file dynamically
cat <<EOF > /etc/systemd/system/omnichat.service
[Unit]
Description=omnichat backend
After=network.target

[Service]
Type=simple
User=$ACTUAL_USER
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/env python3 $PROJECT_DIR/backend/main.py
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