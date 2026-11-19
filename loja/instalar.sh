#!/bin/bash
# ============================================================
#  Loja do Jeff — instalação automática (Oracle Cloud, Ubuntu)
#  Cole este texto inteiro em "cloud-init script" ao criar a VM.
#  Troque SÓ a linha abaixo por uma senha sua:
SENHA_SETUP="TROQUE-POR-UMA-SENHA-SUA"
# ============================================================
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nodejs caddy curl iptables-persistent

# libera as portas 80/443 no firewall interno da imagem da Oracle
iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT || true
iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT || true
netfilter-persistent save || true

IP=$(curl -fsS https://api.ipify.org)
HOST="${IP//./-}.sslip.io"            # endereço https grátis, sem precisar de domínio
RAW="https://raw.githubusercontent.com/Gabrielbatman266/Link-leve-jeff/main/loja/server.js"

mkdir -p /opt/loja/dados
curl -fsS "$RAW" -o /opt/loja/server.js
[ -f /opt/loja/.env ] || cat > /opt/loja/.env <<ENV
PUBLIC_URL=https://$HOST
ALLOWED_ORIGINS=https://gabrielbatman266.github.io
SENHA_SETUP=$SENHA_SETUP
DATA_DIR=/opt/loja/dados
ENV
chmod 600 /opt/loja/.env

cat > /etc/systemd/system/loja.service <<UNIT
[Unit]
Description=Loja do Jeff (Pix SyncPay)
After=network-online.target
[Service]
WorkingDirectory=/opt/loja
ExecStart=/usr/bin/node /opt/loja/server.js
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT

printf '%s {\n  reverse_proxy localhost:8787\n}\n' "$HOST" > /etc/caddy/Caddyfile

# atualização automática do servidor, todo dia às 4h
cat > /etc/cron.daily/loja-atualiza <<CRON
#!/bin/sh
curl -fsS "$RAW" -o /opt/loja/server.js.novo && node --check /opt/loja/server.js.novo && mv /opt/loja/server.js.novo /opt/loja/server.js && systemctl restart loja
CRON
chmod +x /etc/cron.daily/loja-atualiza

systemctl daemon-reload
systemctl enable --now loja
systemctl restart caddy
echo "PRONTO: abra https://$HOST/configurar" | tee /opt/loja/LEIA.txt
