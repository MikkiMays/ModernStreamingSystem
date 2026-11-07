#!/usr/bin/env bash
# Клиент туннеля на сервере Cord, где YouTube режут (R196): 127.0.0.1:3128 → зашифрованно → прокси на узле за рубежом.
#
#   sudo PSK='cord:<ключ из tunnel.psk узла>' bash client.sh <адрес-узла>
#
# Ключ — только через окружение: в командной строке его видели бы другие процессы. Затем в `.env` сервера Cord:
#   CINEMA_PROXY_YOUTUBE=http://cord:<пароль из .password узла>@127.0.0.1:3128
# и пересоздать службу кинозала. Общий CINEMA_PROXY не задавать: остальным площадкам этот прокси не нужен и не откроет их.
set -euo pipefail
[[ $# -eq 1 && -n "${PSK:-}" ]] || { echo "Использование: PSK='cord:<ключ>' bash client.sh <адрес-узла>" >&2; exit 2; }
command -v stunnel4 >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq stunnel4 >/dev/null
systemctl disable --now stunnel4 >/dev/null 2>&1 || true
umask 077
install -d -m 750 -o root -g stunnel4 /etc/cord
printf '%s\n' "$PSK" > /etc/cord/youtube-tunnel.psk
chown root:stunnel4 /etc/cord/youtube-tunnel.psk; chmod 640 /etc/cord/youtube-tunnel.psk
cat > /etc/cord/youtube-tunnel.conf <<CONF
foreground = yes
pid =
syslog = no
[cord-youtube]
client = yes
accept = 127.0.0.1:3128
connect = $1:8443
ciphers = PSK
sslVersion = TLSv1.2
PSKsecrets = /etc/cord/youtube-tunnel.psk
CONF
# umask 077 закрыл настройку и от самой службы.
chown root:stunnel4 /etc/cord/youtube-tunnel.conf; chmod 640 /etc/cord/youtube-tunnel.conf
cat > /etc/systemd/system/cord-youtube-tunnel.service <<UNIT
[Unit]
Description=Cord: зашифрованный туннель к прокси YouTube
After=network-online.target
Wants=network-online.target
[Service]
User=stunnel4
ExecStart=/usr/bin/stunnel4 /etc/cord/youtube-tunnel.conf
Restart=always
RestartSec=3
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
UNIT
chmod 644 /etc/systemd/system/cord-youtube-tunnel.service
systemctl daemon-reload
systemctl enable cord-youtube-tunnel >/dev/null 2>&1
systemctl restart cord-youtube-tunnel
sleep 1
systemctl is-active cord-youtube-tunnel
ss -ltn | grep -q '127.0.0.1:3128 ' && echo "Туннель слушает 127.0.0.1:3128"
