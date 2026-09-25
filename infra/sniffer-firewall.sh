#!/usr/bin/env bash
#
# Cord — стена сети плеера страниц кинозала (контейнер `sniffer`).
#
#   sudo bash infra/sniffer-firewall.sh apply  [подсеть]   поставить стену (повторно — ничего не меняет)
#   sudo bash infra/sniffer-firewall.sh check  [подсеть]   показать стену; нет хоть одного правила — код 1
#   sudo bash infra/sniffer-firewall.sh remove [подсеть]   убрать стену этой подсети
#   sudo bash infra/sniffer-firewall.sh quarantine         остановить плеер страниц: стена не встала
#   sudo bash infra/sniffer-firewall.sh --install          поставить единицы systemd и стену сейчас
#
# ЗАЧЕМ. Плеер страниц исполняет код страниц, которые вставил любой участник, в Chromium без его
# песочницы (в контейнере без привилегий она не поднимается). Сам браузер ходит наружу только через
# охраняемый выход внутри контейнера, но уязвимость рендерера дала бы код в контейнере — и прямую сеть
# моста. Поэтому у контейнера своя сеть (`sniffer` в compose.yaml, подсеть `CINEMA_SNIFFER_SUBNET`, по
# умолчанию 10.231.0.0/24), а здесь — стена вокруг неё. Ответы (conntrack ESTABLISHED/RELATED) она не
# трогает: к плееру страниц ходит служба через опубликованный порт, и его ответы идут своим путём.
#
# ИЗ ЧЕГО СТЕНА.
#   - DOCKER-USER — то, что хост пересылает: из подсети нельзя открыть НОВОЕ соединение ни в одну частную,
#     служебную и групповую сеть (соседние контейнеры, сети хоста, метаданные облака). Своя подсеть —
#     исключение первым правилом (RETURN): соседей там нет, кроме самого плеера страниц (и на стенде
#     разработчика — сайта-фикстуры), а мост с включённым br_netfilter гонит и их трафик через FORWARD.
#     Цепочку DOCKER-USER и переход в неё из FORWARD скрипт при нужде создаёт сам: после перезагрузки стена
#     ставится РАНЬШЕ docker, а docker существующую DOCKER-USER не трогает (только ставит переход в неё
#     первым в FORWARD) — так контейнер не успевает подняться без стены.
#   - INPUT — сам хост (шлюз подсети, docker0, внешний адрес, все его порты): из подсети — ни одного нового
#     соединения. DNS контейнера это не задевает: его спрашивают у встроенного резолвера docker внутри сети
#     самого контейнера (127.0.0.11), а наружу тот ходит из той же сети — это не вход хоста. От UFW стена
#     не зависит и его не трогает.
#   - Метка `/run/cord-sniffer/<подсеть>` — «стена этой подсети проверена». Её пишут apply и прошедший
#     check, убирают remove, неудачный apply или check и quarantine. Плеер страниц видит каталог (только
#     чтение) и без метки своей подсети страниц не открывает. /run живёт в памяти: после перезагрузки меток
#     нет, пока единица не поставит стену заново.
#
# ЕСЛИ СТЕНА НЕ ВСТАЛА. `cord-sniffer-firewall.service` упала — systemd запускает
# `cord-sniffer-quarantine.service`: как только поднят docker, он останавливает контейнер `sniffer`
# (`restart: unless-stopped` его после этого сам не поднимет). update.sh и setup.sh без прошедшего check
# плеер страниц не запускают.
#
# IPv6 у этой сети нет (compose не включает его), поэтому правил ip6tables нет тоже.
set -euo pipefail

cd "$(dirname "$0")/.."
[[ -f compose.yaml ]] || { echo "Запускать из каталога ModernStreamingSystem." >&2; exit 1; }

TAG="cord-sniffer"
CHAIN="DOCKER-USER"
# Куда из подсети плеера страниц новым соединением нельзя: частные сети (RFC 1918), link-local и
# метаданные облака, CGNAT, «эта сеть» и групповая рассылка.
BLOCKED=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 0.0.0.0/8 224.0.0.0/4)
# Каталог меток; плееру страниц он смонтирован только для чтения (compose.yaml).
MARKS="/run/cord-sniffer"
# Чужой держит блокировку xtables — подождать её, а не упасть: упавшая стена останавливает плеер страниц.
IPT=(iptables -w 10)

subnet() {
  local found="${1:-${CINEMA_SNIFFER_SUBNET:-}}"
  if [[ -z "$found" && -f .env ]]; then
    found="$(sed -n 's/^CINEMA_SNIFFER_SUBNET=//p' .env | tail -1)"
  fi
  found="${found:-10.231.0.0/24}"
  # Только IPv4 с маской: подсеть уходит в аргументы iptables и в имя метки, и ничего другого там быть не должно.
  if [[ ! "$found" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]]; then
    echo "Непонятная подсеть: $found (нужна вида 10.231.0.0/24)" >&2
    exit 2
  fi
  printf '%s' "$found"
}

own() { printf '%s\n' -s "$1" -d "$1" -m comment --comment "$TAG" -j RETURN; }
wall() { printf '%s\n' -s "$1" -d "$2" -m conntrack --ctstate NEW -m comment --comment "$TAG" -j DROP; }
inbound() { printf '%s\n' -s "$1" -m conntrack --ctstate NEW -m comment --comment "$TAG" -j DROP; }

# Есть ли правило: цепочка, затем то, что его печатает (`own`, `wall`, `inbound` с аргументами).
have() {
  local chain="$1" rule
  shift
  mapfile -t rule < <("$@")
  "${IPT[@]}" -C "$chain" "${rule[@]}" 2>/dev/null
}

# Поставить правило, если его нет: цепочка, затем то, что его печатает. Новое встаёт первым в цепочке.
put() {
  local chain="$1" rule
  shift
  mapfile -t rule < <("$@")
  "${IPT[@]}" -C "$chain" "${rule[@]}" 2>/dev/null || "${IPT[@]}" -I "$chain" "${rule[@]}"
}

# Номер строки первого правила подсети в `iptables -S DOCKER-USER`, которое кончается данным действием.
line_of() { "${IPT[@]}" -S "$CHAIN" | grep -n -- "-s $1 .*--comment $TAG -j $2\$" | head -1 | cut -d: -f1; }

mark_of() { printf '%s/%s' "$MARKS" "${1//\//_}"; }

# Метка пишется целиком под скрытым именем и переименовывается: плеер страниц считает меткой только файл с
# именем подсети и ею внутри, так что недописанная метка не считается никогда.
mark() {
  local file draft
  file="$(mark_of "$1")"
  draft="$MARKS/.${file##*/}.new"
  mkdir -p "$MARKS"
  chmod 755 "$MARKS"
  printf '%s\n' "$1" >"$draft"
  chmod 644 "$draft"
  mv -f "$draft" "$file"
}

unmark() { rm -f "$(mark_of "$1")" 2>/dev/null || true; }

# Поставить всё, чего нет. Каждое `|| return 1`: функция зовётся из `if`, и `set -e` внутри неё не действует.
place() {
  local net="$1" range rule
  "${IPT[@]}" -nL "$CHAIN" >/dev/null 2>&1 || "${IPT[@]}" -N "$CHAIN" || return 1
  "${IPT[@]}" -C FORWARD -j "$CHAIN" 2>/dev/null || "${IPT[@]}" -I FORWARD -j "$CHAIN" || return 1
  for range in "${BLOCKED[@]}"; do
    put "$CHAIN" wall "$net" "$range" || return 1
  done
  # Исключение своей подсети — первым, выше запретов. Если оно оказалось ниже (запрет пропал и вернулся
  # наверх, правило переставили руками), оно переставляется наверх.
  mapfile -t rule < <(own "$net")
  if "${IPT[@]}" -C "$CHAIN" "${rule[@]}" 2>/dev/null && (($(line_of "$net" RETURN) > $(line_of "$net" DROP))); then
    "${IPT[@]}" -D "$CHAIN" "${rule[@]}" || return 1
  fi
  put "$CHAIN" own "$net" || return 1
  put INPUT inbound "$net" || return 1
}

# Всё ли на месте. Что не так — строкой на каждую нехватку; код 1, если хоть что-то не так.
verify() {
  local net="$1" range missing=0
  "${IPT[@]}" -nL "$CHAIN" >/dev/null 2>&1 || { echo "  нет цепочки $CHAIN"; return 1; }
  "${IPT[@]}" -C FORWARD -j "$CHAIN" 2>/dev/null || { echo "  нет перехода FORWARD → $CHAIN"; missing=1; }
  have "$CHAIN" own "$net" || { echo "  нет исключения своей подсети"; missing=1; }
  for range in "${BLOCKED[@]}"; do
    have "$CHAIN" wall "$net" "$range" || { echo "  НЕТ запрета в $range"; missing=1; }
  done
  if ((!missing)) && (($(line_of "$net" RETURN) > $(line_of "$net" DROP))); then
    echo "  исключение своей подсети стоит ниже запретов"
    missing=1
  fi
  have INPUT inbound "$net" || { echo "  НЕТ запрета к самому хосту (INPUT)"; missing=1; }
  return "$missing"
}

apply() {
  local net="$1" problems
  if place "$net" && problems="$(verify "$net")"; then
    mark "$net"
    echo "стена плеера страниц для $net поставлена"
    return 0
  fi
  unmark "$net"
  echo "стена плеера страниц для $net НЕ поставлена${problems:+:$'\n'$problems}" >&2
  exit 1
}

check() {
  local net="$1"
  if ! "${IPT[@]}" -nL INPUT >/dev/null 2>&1; then
    # Без прав метку не трогаем: «не смог прочитать» не значит «стены нет».
    echo "iptables не читается (нужен root): sudo bash infra/sniffer-firewall.sh check" >&2
    exit 1
  fi
  echo "Стена плеера страниц для подсети $net:"
  {
    "${IPT[@]}" -S INPUT | grep -- "-s $net .*--comment $TAG" || true
    "${IPT[@]}" -S FORWARD | grep -- "-j $CHAIN\$" || true
    "${IPT[@]}" -S "$CHAIN" 2>/dev/null | grep -- "-s $net .*--comment $TAG" || true
  } | sed 's/^/  /'
  if verify "$net"; then
    mark "$net"
    echo "  метка: $(mark_of "$net")"
    echo "стена плеера страниц для $net — на месте"
  else
    unmark "$net"
    echo "стена плеера страниц для $net — НЕ ПОЛНАЯ (метка снята): sudo bash infra/sniffer-firewall.sh apply" >&2
    exit 1
  fi
}

remove() {
  local net="$1" range rule
  unmark "$net"
  for range in "${BLOCKED[@]}"; do
    mapfile -t rule < <(wall "$net" "$range")
    while "${IPT[@]}" -C "$CHAIN" "${rule[@]}" 2>/dev/null; do "${IPT[@]}" -D "$CHAIN" "${rule[@]}"; done
  done
  mapfile -t rule < <(own "$net")
  while "${IPT[@]}" -C "$CHAIN" "${rule[@]}" 2>/dev/null; do "${IPT[@]}" -D "$CHAIN" "${rule[@]}"; done
  mapfile -t rule < <(inbound "$net")
  while "${IPT[@]}" -C INPUT "${rule[@]}" 2>/dev/null; do "${IPT[@]}" -D INPUT "${rule[@]}"; done
  # Цепочку DOCKER-USER и переход в неё не трогаем: они общие с docker.
  echo "стена плеера страниц для $net убрана"
}

quarantine() {
  local net="$1"
  unmark "$net"
  # docker зовётся, только если он уже работает: иначе его сокет поднял бы docker ради одной остановки.
  if systemctl is-active --quiet docker.service 2>/dev/null; then
    docker compose stop sniffer || true
  fi
  echo "Плеер страниц остановлен: стены сети для $net нет. Журнал: journalctl -u cord-sniffer-firewall" >&2
}

install() {
  local root unit
  root="$(pwd)"
  if [[ "$(id -u)" != 0 ]]; then
    echo "Стена плеера страниц ставится от root: sudo bash infra/sniffer-firewall.sh --install" >&2
    exit 1
  fi
  if ! command -v systemctl >/dev/null; then
    echo "systemd здесь нет: поставьте стену сейчас (apply) и после каждой перезагрузки — до docker." >&2
    apply "$(subnet "")"
    exit 0
  fi
  for unit in cord-sniffer-firewall.service cord-sniffer-quarantine.service; do
    sed "s#@CORD_ROOT@#${root}#g" "infra/$unit" >"/etc/systemd/system/$unit"
  done
  systemctl daemon-reload
  systemctl enable cord-sniffer-firewall.service >/dev/null
  # Стена — сейчас, а не при следующей загрузке: единица oneshot с RemainAfterExit, restart её повторит.
  # Не встала — единица упала, и карантин уже останавливает плеер страниц.
  systemctl restart cord-sniffer-firewall.service
  echo "Стена плеера страниц: cord-sniffer-firewall.service включена. Проверить — sudo bash infra/sniffer-firewall.sh check"
}

case "${1:-}" in
  apply) apply "$(subnet "${2:-}")" ;;
  check) check "$(subnet "${2:-}")" ;;
  remove) remove "$(subnet "${2:-}")" ;;
  quarantine) quarantine "$(subnet "${2:-}")" ;;
  --install) install ;;
  *)
    sed -n '3,9p' "$0" | sed 's/^# \?//' >&2
    exit 2
    ;;
esac
