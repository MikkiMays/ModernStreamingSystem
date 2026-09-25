#!/usr/bin/env bash
#
# Cord — стена сети плеера страниц кинозала (контейнер `sniffer`).
#
#   sudo bash infra/sniffer-firewall.sh apply  [подсеть]   поставить стену (повторно — ничего не меняет)
#   sudo bash infra/sniffer-firewall.sh check  [подсеть]   показать стену; нет хоть одного правила — код 1
#   sudo bash infra/sniffer-firewall.sh remove [подсеть]   убрать стену этой подсети
#   sudo bash infra/sniffer-firewall.sh quarantine         остановить плеер страниц: стена не встала
#   sudo bash infra/sniffer-firewall.sh --install          поставить единицы systemd и стену сейчас
#        bash infra/sniffer-firewall.sh validate [подсеть] годится ли подсеть этому хосту; правил не трогает
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
# КАКАЯ ПОДСЕТЬ ГОДИТСЯ (`validate`; apply и check без неё стену не ставят и метку снимают). Подсеть — это и
# исключение «своя подсеть» первым правилом, и запрет INPUT: слишком широкая открыла бы из неё всё, что внутри
# (0.0.0.0/0 — вообще всё), а INPUT запер бы хост от того, кто в неё попал, — например, от SSH администратора.
#   - IPv4 без ведущих нулей: iptables читает «010» восьмеричным 8, docker такую строку не принимает, и стена
#     встала бы не вокруг той сети; октеты — не больше 255;
#   - маска /16–/29: шире — чужие сети внутри своей, уже /29 — плееру страниц и шлюзу моста не хватит адресов;
#   - адрес сети: младшие биты — нули (10.231.0.5/24 — не сеть);
#   - не 172.16.0.0/12 — ей UFW этой машины доверяет порты соседних служб (8090/8091), и из неё docker раздаёт
#     свои сети; не служебные 0.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 224.0.0.0/4, 240.0.0.0/4;
#   - в ней нет ни шлюза по умолчанию, ни адреса самого хоста, и она не пересекается ни с одним маршрутом
#     хоста (`ip -4 route show table all`) — кроме моста самой этой сети: маршрута docker (`br-` и двенадцать
#     шестнадцатеричных знаков) ровно на эту подсеть. Он появляется, когда сеть уже поднята, и без этого
#     исключения повторный apply на работающем хосте — периодический или из update.sh — отказал бы сам себе.
#
# ЕСЛИ СТЕНА НЕ ВСТАЛА. `cord-sniffer-firewall.service` упала — systemd запускает
# `cord-sniffer-quarantine.service`: как только поднят docker, он останавливает контейнер `sniffer`
# (`restart: unless-stopped` его после этого сам не поднимет). update.sh и setup.sh без прошедшего check
# плеер страниц не запускают.
#
# ЗАНОВО КАЖДЫЕ ПЯТЬ МИНУТ. Правила iptables переписывают и другие — `ufw reload`, чужой `iptables-restore`,
# перезапуск docker, — а единица загрузки ставит стену один раз. `cord-sniffer-wall.timer` раз в пять минут
# запускает `cord-sniffer-wall.service`: тот же apply (не check — недостающее правило ставится на место, метка
# пишется заново), блокировку xtables ждёт дольше (`CORD_SNIFFER_XTABLES_WAIT`), а не вышло — тот же карантин.
# Снять стену насовсем — сначала таймер, иначе он вернёт её через пять минут:
#   sudo systemctl disable --now cord-sniffer-wall.timer && sudo bash infra/sniffer-firewall.sh remove
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
# Сколько ждать, секунд: при загрузке — десять (docker ждёт стену), периодической единице — дольше.
XTABLES_WAIT="${CORD_SNIFFER_XTABLES_WAIT:-10}"
[[ "$XTABLES_WAIT" =~ ^[1-9][0-9]{0,2}$ ]] || XTABLES_WAIT=10
IPT=(iptables -w "$XTABLES_WAIT")
# Единицы systemd стены: при загрузке, карантин, каждые пять минут.
UNITS=(cord-sniffer-firewall.service cord-sniffer-quarantine.service cord-sniffer-wall.service
  cord-sniffer-wall.timer)

# Подсеть из аргумента, окружения или .env — строкой, как задана; не задана — 10.231.0.0/24.
subnet() {
  local found="${1:-${CINEMA_SNIFFER_SUBNET:-}}"
  if [[ -z "$found" && -f .env ]]; then
    found="$(sed -n 's/^CINEMA_SNIFFER_SUBNET=//p' .env | tail -1)"
  fi
  printf '%s' "${found:-10.231.0.0/24}"
}

# Похоже ли на подсеть IPv4 по форме: четыре октета без ведущих нулей, каждый ≤ 255, и маска ≤ 32. Подсеть
# уходит в аргументы iptables и в имя метки, и ничего другого там быть не должно.
OCTET='(0|[1-9][0-9]{0,2})'
shaped() {
  local octet
  [[ "$1" =~ ^$OCTET\.$OCTET\.$OCTET\.$OCTET/(0|[1-9][0-9]?)$ ]] || return 1
  for octet in "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}"; do
    ((octet <= 255)) || return 1
  done
  ((BASH_REMATCH[5] <= 32))
}

# Адрес IPv4 строкой → число и обратно (форма уже проверена).
number() {
  local IFS=. a b c d
  read -r a b c d <<<"$1"
  printf '%d' $(((a << 24) | (b << 16) | (c << 8) | d))
}
dotted() { printf '%d.%d.%d.%d' $(($1 >> 24 & 255)) $(($1 >> 16 & 255)) $(($1 >> 8 & 255)) $(($1 & 255)); }

# Пересекаются ли два диапазона — адрес (числом) и длина маски каждого.
crosses() { (($1 < $3 + (1 << (32 - $4)) && $3 < $1 + (1 << (32 - $2)))); }

# Слово после ключа в строке `ip`: `after dev default via 10.0.0.1 dev ens3` → ens3.
after() {
  local key="$1"
  shift
  while (($#)); do
    if [[ "$1" == "$key" ]]; then
      printf '%s' "${2:-}"
      return 0
    fi
    shift
  done
}

# Годится ли подсеть этому хосту (правила — в шапке, «КАКАЯ ПОДСЕТЬ ГОДИТСЯ»). Что не так — строкой на каждое;
# код 1, если хоть что-то не так. Ничего не меняет: только читает маршруты и адреса хоста.
suitable() {
  local net="$1" base mask size range kind dest dev gateway previous="" routes="" addresses="" words
  local own=() gateways=() problems=()
  if ! shaped "$net"; then
    echo "  не подсеть IPv4: «$net» (нужна вида 10.231.0.0/24: октеты 0–255 без ведущих нулей и маска)"
    return 1
  fi
  base="$(number "${net%/*}")"
  mask="${net#*/}"
  size=$((1 << (32 - mask)))
  if ((mask < 16 || mask > 29)); then
    echo "  маска /$mask: годится /16–/29 (шире — чужие сети внутри своей, уже — не хватит адресов)"
    return 1
  fi
  if ((base % size)); then
    echo "  $net — не адрес сети: у /$mask младшие $((32 - mask)) бит — нули" \
      "(сеть здесь — $(dotted $((base - base % size)))/$mask)"
    return 1
  fi
  for range in 172.16.0.0/12 0.0.0.0/8 127.0.0.0/8 169.254.0.0/16 224.0.0.0/4 240.0.0.0/4; do
    crosses "$base" "$mask" "$(number "${range%/*}")" "${range#*/}" || continue
    if [[ "$range" == 172.16.0.0/12 ]]; then
      problems+=("пересекается с 172.16.0.0/12: ей доверяет UFW этой машины, и из неё раздаёт сети docker")
    else
      problems+=("пересекается со служебным диапазоном $range")
    fi
  done
  # Не прочитали маршруты или адреса — это не «пересечений нет»: без них подсеть не годится.
  if ! command -v ip >/dev/null; then
    problems+=("нет команды ip (iproute2): маршрутов и адресов хоста не проверить")
  elif ! routes="$(ip -4 route show table all 2>&1)" || ! addresses="$(ip -4 -o addr show 2>&1)"; then
    problems+=("маршруты или адреса хоста не читаются: ${routes}${addresses}")
  else
    # Маршруты всех таблиц. local и broadcast — это адреса самого хоста (они ниже, отдельно), `nexthop` —
    # продолжение многопутевого маршрута: шлюз по умолчанию бывает и там.
    while read -r -a words; do
      ((${#words[@]})) || continue
      if [[ "${words[0]}" == nexthop ]]; then
        gateway="$(after via "${words[@]}")"
        [[ "$previous" == default && -n "$gateway" ]] && gateways+=("$gateway")
        continue
      fi
      kind="${words[0]}"
      case "$kind" in
        local | broadcast | multicast | anycast | nat)
          previous=""
          continue
          ;;
        unicast | unreachable | blackhole | prohibit | throw) words=("${words[@]:1}") ;;
      esac
      dest="${words[0]:-}"
      previous="$dest"
      if [[ "$dest" == default || "$dest" == 0.0.0.0/0 ]]; then
        previous=default
        gateway="$(after via "${words[@]}")"
        [[ -n "$gateway" ]] && gateways+=("$gateway")
        continue
      fi
      [[ "$dest" == */* ]] || dest="$dest/32"
      shaped "$dest" || continue
      dev="$(after dev "${words[@]}")"
      if [[ "$dest" == "$net" && "$dev" =~ ^br-[0-9a-f]{12}$ ]]; then
        own+=("$dev")
        continue
      fi
      if crosses "$base" "$mask" "$(number "${dest%/*}")" "${dest#*/}"; then
        problems+=("пересекается с маршрутом хоста: ${words[*]}")
      fi
    done <<<"$routes"
    for gateway in "${gateways[@]}"; do
      shaped "$gateway/32" || continue
      if crosses "$base" "$mask" "$(number "$gateway")" 32; then
        problems+=("в ней шлюз по умолчанию этого хоста: $gateway")
      fi
    done
    # Адреса самого хоста; адрес моста этой же сети (его шлюз) — свой.
    while read -r -a words; do
      ((${#words[@]} >= 4)) || continue
      dev="${words[1]%%@*}"
      dest="${words[3]%/*}"
      [[ " ${own[*]} " == *" $dev "* ]] && continue
      shaped "$dest/32" || continue
      if crosses "$base" "$mask" "$(number "$dest")" 32; then
        problems+=("в ней адрес этого хоста: $dest ($dev)")
      fi
    done <<<"$addresses"
  fi
  ((${#problems[@]})) || return 0
  printf '  %s\n' "${problems[@]}"
  return 1
}

# Подсеть, для которой стену можно ставить и проверять. Не годится — причины и код 2, а метка её (если имя
# вообще похоже на подсеть) снимается: стены для такой подсети нет, что бы ни стояло раньше.
wanted() {
  local net="$1" problems
  if problems="$(suitable "$net")"; then
    return 0
  fi
  if shaped "$net"; then unmark "$net"; fi
  printf 'Подсеть плеера страниц %s не годится этому хосту — стена не ставится:\n%s\n' "$net" "$problems" >&2
  exit 2
}

# Убрать можно и стену подсети, которая сейчас не годится (поставленную до проверки): нужна только форма.
formed() {
  shaped "$1" && return 0
  echo "Непонятная подсеть: «$1» (нужна вида 10.231.0.0/24)" >&2
  exit 2
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

# Карантин останавливает плеер страниц при любой подсети — и при той, что не годится (это тоже «стены нет»).
quarantine() {
  local net="$1"
  if shaped "$net"; then unmark "$net"; fi
  # docker зовётся, только если он уже работает: иначе его сокет поднял бы docker ради одной остановки.
  if systemctl is-active --quiet docker.service 2>/dev/null; then
    docker compose stop sniffer || true
  fi
  echo "Плеер страниц остановлен: стены сети для $net нет. Журнал: journalctl -u cord-sniffer-firewall" >&2
}

validate() {
  local net="$1" problems
  if problems="$(suitable "$net")"; then
    echo "подсеть плеера страниц $net годится этому хосту"
    return 0
  fi
  printf 'подсеть плеера страниц %s НЕ годится этому хосту:\n%s\n' "$net" "$problems" >&2
  exit 2
}

install() {
  local root unit net
  root="$(pwd)"
  if [[ "$(id -u)" != 0 ]]; then
    echo "Стена плеера страниц ставится от root: sudo bash infra/sniffer-firewall.sh --install" >&2
    exit 1
  fi
  # Подсеть, которая не годится, не ставится ни сейчас, ни при загрузке: отказ — сразу и с причинами, а не
  # в журнале упавшей единицы.
  net="$(subnet "")"
  wanted "$net"
  if ! command -v systemctl >/dev/null; then
    echo "systemd здесь нет: поставьте стену сейчас (apply) и после каждой перезагрузки — до docker." >&2
    apply "$net"
    exit 0
  fi
  for unit in "${UNITS[@]}"; do
    sed "s#@CORD_ROOT@#${root}#g" "infra/$unit" >"/etc/systemd/system/$unit"
  done
  systemctl daemon-reload
  systemctl enable cord-sniffer-firewall.service >/dev/null
  # Стена — сейчас, а не при следующей загрузке: единица oneshot с RemainAfterExit, restart её повторит.
  # Не встала — единица упала, и карантин уже останавливает плеер страниц.
  systemctl restart cord-sniffer-firewall.service
  # И заново каждые пять минут. Уже включённый таймер `enable --now` не трогает, а новые файлы единиц он
  # подхватывает после daemon-reload сам.
  systemctl enable --now cord-sniffer-wall.timer >/dev/null
  echo "Стена плеера страниц: cord-sniffer-firewall.service и cord-sniffer-wall.timer включены." \
    "Проверить — sudo bash infra/sniffer-firewall.sh check"
}

case "${1:-}" in
  apply)
    net="$(subnet "${2:-}")"
    wanted "$net"
    apply "$net"
    ;;
  check)
    net="$(subnet "${2:-}")"
    wanted "$net"
    check "$net"
    ;;
  remove)
    net="$(subnet "${2:-}")"
    formed "$net"
    remove "$net"
    ;;
  quarantine) quarantine "$(subnet "${2:-}")" ;;
  validate) validate "$(subnet "${2:-}")" ;;
  --install) install ;;
  *)
    sed -n '3,10p' "$0" | sed 's/^# \?//' >&2
    exit 2
    ;;
esac
