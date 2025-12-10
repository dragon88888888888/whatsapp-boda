#!/bin/bash

echo "=== Cloudflare Tunnel Setup ==="

# Instalar cloudflared
if ! command -v cloudflared &> /dev/null; then
    echo "Instalando cloudflared..."
    curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
    sudo dpkg -i cloudflared.deb
    rm cloudflared.deb
    echo "cloudflared instalado correctamente"
else
    echo "cloudflared ya está instalado"
fi

# Verificar versión
cloudflared --version

echo ""
echo "=== Configuración del Túnel ==="
echo ""
echo "Opciones:"
echo "1. Túnel rápido (sin autenticación, URL temporal)"
echo "2. Túnel con dominio personalizado (requiere cuenta Cloudflare)"
echo ""
read -p "Selecciona una opción (1 o 2): " option

if [ "$option" == "1" ]; then
    echo ""
    echo "Iniciando bot de WhatsApp en segundo plano..."
    bun chatwhats.js > bot.log 2>&1 &
    BOT_PID=$!
    echo "Bot iniciado con PID: $BOT_PID"

    echo ""
    echo "Esperando 3 segundos para que el bot inicie..."
    sleep 3

    echo ""
    echo "Iniciando túnel rápido..."
    echo "Presiona Ctrl+C para detener (esto también detendrá el bot)"
    echo ""

    trap "echo 'Deteniendo bot...'; kill $BOT_PID 2>/dev/null; exit" INT TERM

    cloudflared tunnel --url http://localhost:5000

elif [ "$option" == "2" ]; then
    echo ""
    echo "=== Configuración de túnel con dominio ==="
    echo ""
    echo "Paso 1: Autenticarse con Cloudflare"
    cloudflared tunnel login

    echo ""
    read -p "Nombre para tu túnel: " TUNNEL_NAME

    echo ""
    echo "Creando túnel..."
    cloudflared tunnel create $TUNNEL_NAME

    TUNNEL_ID=$(cloudflared tunnel list | grep $TUNNEL_NAME | awk '{print $1}')
    echo "Túnel creado con ID: $TUNNEL_ID"

    echo ""
    read -p "Tu dominio (ejemplo: bot.tudominio.com): " DOMAIN

    echo ""
    echo "Configurando DNS..."
    cloudflared tunnel route dns $TUNNEL_NAME $DOMAIN

    echo ""
    echo "Creando archivo de configuración..."
    mkdir -p ~/.cloudflared
    cat > ~/.cloudflared/config.yml <<EOF
tunnel: $TUNNEL_ID
credentials-file: /home/$USER/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: $DOMAIN
    service: http://localhost:5000
  - service: http_status:404
EOF

    echo ""
    echo "Configuración completa!"
    echo ""
    echo "Creando servicio systemd para el bot..."
    sudo bash -c "cat > /etc/systemd/system/whatsapp-bot.service <<EOF
[Unit]
Description=WhatsApp Wedding Bot
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
ExecStart=$(which bun) chatwhats.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF"

    echo ""
    echo "Instalando servicios..."
    sudo systemctl daemon-reload
    sudo systemctl enable whatsapp-bot
    sudo systemctl start whatsapp-bot

    sudo cloudflared service install
    sudo systemctl start cloudflared
    sudo systemctl enable cloudflared

    echo ""
    echo "Servicios instalados y ejecutándose!"
    echo ""
    echo "Tu webhook URL es: https://$DOMAIN"
    echo ""
    echo "Comandos útiles:"
    echo "Bot WhatsApp:"
    echo "  sudo systemctl status whatsapp-bot"
    echo "  sudo systemctl restart whatsapp-bot"
    echo "  sudo systemctl stop whatsapp-bot"
    echo "  sudo journalctl -u whatsapp-bot -f"
    echo ""
    echo "Cloudflare Tunnel:"
    echo "  sudo systemctl status cloudflared"
    echo "  sudo systemctl restart cloudflared"
    echo "  sudo systemctl stop cloudflared"

else
    echo "Opción no válida"
    exit 1
fi
