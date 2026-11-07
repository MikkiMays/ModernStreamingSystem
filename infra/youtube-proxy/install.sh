#!/usr/bin/env bash
# Поставить или обновить прокси YouTube на узле за рубежом (R196). Запускать на этом узле из каталога с этими файлами.
#
#   sudo bash install.sh <адрес-сервера-cord> [ещё адреса…]
#
# Squid слушает только loopback, снаружи — зашифрованный туннель stunnel на 8443 (TLS с общим ключом, без имени сервера) и только с
# перечисленных адресов. Туннель — своя служба systemd с автоперезапуском. Пароль и ключ создаются один раз и лежат здесь же (0600);
# в репозиторий и журналы не попадают.
set -euo pipefail
cd "$(dirname "$0")"
[[ $# -ge 1 ]] || { echo "Нужен хотя бы один адрес сервера Cord" >&2; exit 2; }
umask 077
[[ -s .password ]] || openssl rand -hex 24 > .password
[[ -s tunnel.psk ]] || printf 'cord:%s\n' "$(openssl rand -hex 32)" > tunnel.psk
printf 'cord:%s\n' "$(openssl passwd -apr1 "$(cat .password)")" > passwd
chmod 644 passwd # Squid в контейнере читает файл своим пользователем.
docker compose pull -q
docker compose up -d --force-recreate
command -v stunnel4 >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq stunnel4 >/dev/null
# Служба пакета не нужна: у неё свой каталог настроек, а падение она не перезапускает.
systemctl disable --now stunnel4 >/dev/null 2>&1 || true
install -d -m 750 -o root -g stunnel4 /etc/cord
install -m 640 -o root -g stunnel4 tunnel.psk /etc/cord/youtube-tunnel.psk
cat > /etc/cord/youtube-tunnel.conf <<CONF
foreground = yes
pid =
syslog = no
[cord-youtube]
accept = 0.0.0.0:8443
connect = 127.0.0.1:3128
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
while ufw status numbered | grep -q 'cord youtube proxy'; do
  n=$(ufw status numbered | grep -m1 'cord youtube proxy' | sed -E 's/^\[ *([0-9]+)\].*/\1/'); ufw --force delete "$n" >/dev/null
done
for ip in "$@"; do ufw allow from "$ip" to any port 8443 proto tcp comment 'cord youtube proxy' >/dev/null; done
sleep 2
docker compose ps --format '{{.Name}} {{.Status}}'
systemctl is-active cord-youtube-tunnel
ss -ltn | grep -E ':(3128|8443) ' | awk '{print $4}'
echo "Готово. На сервере Cord: PSK='<содержимое $(pwd)/tunnel.psk>' bash client.sh $(hostname -I | cut -d' ' -f1); пароль прокси — в $(pwd)/.password"
