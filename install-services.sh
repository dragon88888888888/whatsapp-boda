#!/bin/bash

echo "=== Instalando servicios systemd ==="

# Obtener el directorio actual
WORKDIR=$(pwd)
BUN_PATH=$(which bun)

echo "Directorio de trabajo: $WORKDIR"
echo "Ruta de Bun: $BUN_PATH"

# Crear servicio para el bot de WhatsApp
echo ""
echo "Creando servicio whatsapp-bot..."
sudo tee /etc/systemd/system/whatsapp-bot.service > /dev/null <<EOF
[Unit]
Description=WhatsApp Wedding Bot
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$WORKDIR
ExecStart=$BUN_PATH run chatwhats.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Instalar cloudflared si no está instalado
if ! command -v cloudflared &> /dev/null; then
    echo ""
    echo "Instalando cloudflared..."
    curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
    sudo dpkg -i cloudflared.deb
    rm cloudflared.deb
    echo "cloudflared instalado"
fi

# Crear servicio para Cloudflare Tunnel
echo ""
echo "Creando servicio cloudflared-tunnel..."
sudo tee /etc/systemd/system/cloudflared-tunnel.service > /dev/null <<EOF
[Unit]
Description=Cloudflare Tunnel
After=network.target whatsapp-bot.service

[Service]
Type=simple
User=$USER
ExecStart=/usr/bin/cloudflared tunnel --url http://localhost:5000 --no-autoupdate
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Recargar systemd
echo ""
echo "Recargando systemd..."
sudo systemctl daemon-reload

# Habilitar servicios
echo "Habilitando servicios..."
sudo systemctl enable whatsapp-bot
sudo systemctl enable cloudflared-tunnel

# Iniciar servicios
echo "Iniciando servicios..."
sudo systemctl start whatsapp-bot
sleep 3
sudo systemctl start cloudflared-tunnel

echo ""
echo "=== Servicios instalados y ejecutándose ==="
echo ""
echo "Comandos útiles:"
echo ""
echo "Ver estado:"
echo "  sudo systemctl status whatsapp-bot"
echo "  sudo systemctl status cloudflared-tunnel"
echo ""
echo "Ver logs en tiempo real:"
echo "  sudo journalctl -u whatsapp-bot -f"
echo "  sudo journalctl -u cloudflared-tunnel -f"
echo ""
echo "Ver últimas 100 líneas de logs:"
echo "  sudo journalctl -u whatsapp-bot -n 100"
echo "  sudo journalctl -u cloudflared-tunnel -n 100"
echo ""
echo "Reiniciar servicios:"
echo "  sudo systemctl restart whatsapp-bot"
echo "  sudo systemctl restart cloudflared-tunnel"
echo ""
echo "Detener servicios:"
echo "  sudo systemctl stop whatsapp-bot"
echo "  sudo systemctl stop cloudflared-tunnel"
echo ""
echo "Obtener URL del túnel:"
echo "  sudo journalctl -u cloudflared-tunnel | grep trycloudflare.com"
echo ""
echo "Esperando 10 segundos para obtener URL del túnel..."
sleep 10

echo ""
echo "=== URL del Túnel ==="
sudo journalctl -u cloudflared-tunnel --since "1 minute ago" | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1
echo ""
