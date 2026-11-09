#!/usr/bin/env bash
# Выход кинозала в ivi через Россию (OWNER-ACTIONS п. 13). ivi отдаёт бесплатный каталог и потоки только адресам в России,
# а службы кинозала продукта живут на meet во Франкфурте. Запускать на узле с российским адресом (сейчас msk, 157.22.241.114):
#
#   sudo bash install.sh <адрес-сервера-cord> [ещё адреса…]      # например 108.165.32.23 (продукт) 108.165.32.75 (стенд)
#
# Squid слушает публичный адрес узла на 3128, пускает только перечисленные адреса (squid и ufw), только домены ivi и только с
# паролем; ничего не кэширует, адресов в журнал не пишет, о клиенте не говорит. Туннеля, как у YouTube (`../youtube-proxy`),
# нет намеренно: его там требует DPI на открытом имени googlevideo.com, а ivi — российская площадка с российского узла.
# Пароль создаётся один раз в /root/cord-ivi/password (0600). На сервере Cord — строка в `.env`:
#   CINEMA_PROXY_IVI=http://cord:<пароль>@<адрес узла>:3128
# и `docker compose up -d --no-deps services`. Проверка: geocheck ivi через прокси отвечает "country_code":"RU".
set -euo pipefail
[[ $# -ge 1 ]] || { echo "Нужен хотя бы один адрес сервера Cord" >&2; exit 2; }
for ip in "$@"; do [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "Не IPv4: $ip" >&2; exit 2; }; done
public=$(ip -4 route get 1.1.1.1 | sed -nE 's/.* src ([0-9.]+).*/\1/p')
[[ -n "$public" ]] || { echo "Не нашёл публичный адрес узла" >&2; exit 1; }
command -v squid >/dev/null && command -v htpasswd >/dev/null ||
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq squid apache2-utils >/dev/null
umask 077
install -d -m 700 /root/cord-ivi
[[ -s /root/cord-ivi/password ]] || openssl rand -hex 24 > /root/cord-ivi/password
htpasswd -bc /etc/squid/passwd cord "$(cat /root/cord-ivi/password)" 2>/dev/null
chown proxy:proxy /etc/squid/passwd; chmod 640 /etc/squid/passwd
[[ -f /etc/squid/squid.conf.dist ]] || cp /etc/squid/squid.conf /etc/squid/squid.conf.dist
cat > /etc/squid/squid.conf <<CONF
# Cord: выход кинозала в ivi через Россию (infra/ivi-proxy/install.sh, OWNER-ACTIONS п. 13).
http_port $public:3128
auth_param basic program /usr/lib/squid/basic_ncsa_auth /etc/squid/passwd
auth_param basic realm cord-ivi
acl cord_core src $(printf '%s/32 ' "$@")
acl authed proxy_auth REQUIRED
acl ivi dstdomain .ivi.ru .ivi.tv
acl SSL_ports port 443
acl Safe_ports port 80 443
acl CONNECT method CONNECT
http_access deny !Safe_ports
http_access deny CONNECT !SSL_ports
http_access deny !cord_core
http_access deny !ivi
http_access allow authed
http_access deny all
cache deny all
access_log none
forwarded_for delete
via off
visible_hostname cord-ivi
CONF
chmod 644 /etc/squid/squid.conf
squid -k parse >/dev/null 2>&1 || { squid -k parse; exit 1; }
systemctl enable -q squid
systemctl restart squid
while ufw status numbered | grep -q 'cord ivi'; do
  n=$(ufw status numbered | grep -m1 'cord ivi' | sed -E 's/^\[ *([0-9]+)\].*/\1/'); ufw --force delete "$n" >/dev/null
done
for ip in "$@"; do ufw allow from "$ip" to any port 3128 proto tcp comment 'cord ivi' >/dev/null; done
sleep 2
systemctl is-active squid
ss -ltn | grep ':3128 ' | awk '{print $4}'
echo "Готово. На сервере Cord: CINEMA_PROXY_IVI=http://cord:<пароль из /root/cord-ivi/password>@$public:3128"
