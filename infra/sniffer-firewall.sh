#!/usr/bin/env bash
#
# Cord — стена сети плеера страниц кинозала (контейнер `sniffer`).
#
#   sudo bash infra/sniffer-firewall.sh apply  [подсеть]   поставить правила (повторно — ничего не меняет)
#   sudo bash infra/sniffer-firewall.sh check  [подсеть]   показать правила; нет хоть одного — код 1
#   sudo bash infra/sniffer-firewall.sh remove [подсеть]   убрать правила этой подсети
#   sudo bash infra/sniffer-firewall.sh --install          поставить `cord-sniffer-firewall.service`
#
# ЗАЧЕМ. Плеер страниц исполняет код страниц, которые вставил любой участник, в Chromium без его
# песочницы (в контейнере без привилегий она не поднимается). Сам браузер ходит наружу только через
# охраняемый выход внутри контейнера, но уязвимость рендерера дала бы код в контейнере — и прямую сеть
# моста: частные сети хоста, соседние контейнеры, метаданные облака. Поэтому у контейнера своя сеть
# (`sniffer` в compose.yaml, подсеть `CINEMA_SNIFFER_SUBNET`, по умолчанию 10.231.0.0/24), а здесь —
# правила DOCKER-USER: из этой подсети нельзя открыть НОВОЕ соединение ни в одну частную, служебную и
# групповую сеть. Ответы (conntrack ESTABLISHED/RELATED) не трогаются: служба ходит к плееру страниц
# через опубликованный порт, и его ответы идут своим путём.
#
# ЧТО ЗДЕСЬ НЕ ЗАКРЫВАЕТСЯ И ПОЧЕМУ. DOCKER-USER видит только то, что хост пересылает (FORWARD). Адреса
# самого хоста (шлюз подсети, docker0, внешний) — это его вход (INPUT), и его держит UFW: его политика —
# DROP, а доверенные подсети (172.16.0.0/12 для соседних служб на 8090/8091) подсеть плеера страниц не
# включают — поэтому она и выбрана вне 172.16.0.0/12. Плеер страниц проверяет это сам, при старте и раз в
# несколько минут (`sniffer/isolation.py`): дотянулся — отказывает всем страницам.
#
# Своя подсеть — исключение первым правилом (RETURN): соседей там нет, кроме самого плеера страниц (и на
# стенде разработчика — сайта-фикстуры), а мост с включённым br_netfilter гонит и их трафик через FORWARD.
#
# IPv6 у этой сети нет (compose не включает его), поэтому правил ip6tables нет тоже.
#
# Правила живут до перезагрузки; после неё их ставит `cord-sniffer-firewall.service` (после docker).
# Ставит единицу `setup.sh`, на сервере, поставленном раньше, — `update.sh`. UFW этот скрипт не трогает.
set -euo pipefail

cd "$(dirname "$0")/.."
[[ -f compose.yaml ]] || { echo "Запускать из каталога ModernStreamingSystem." >&2; exit 1; }

TAG="cord-sniffer"
CHAIN="DOCKER-USER"
# Куда из подсети плеера страниц новым соединением нельзя: частные сети (RFC 1918), link-local и
# метаданные облака, CGNAT, «эта сеть» и групповая рассылка.
BLOCKED=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 0.0.0.0/8 224.0.0.0/4)

subnet() {
  local found="${1:-${CINEMA_SNIFFER_SUBNET:-}}"
  if [[ -z "$found" && -f .env ]]; then
    found="$(sed -n 's/^CINEMA_SNIFFER_SUBNET=//p' .env | tail -1)"
  fi
  found="${found:-10.231.0.0/24}"
  # Только IPv4 с маской: подсеть уходит в аргументы iptables, и ничего другого там быть не должно.
  if [[ ! "$found" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]]; then
    echo "Непонятная подсеть: $found (нужна вида 10.231.0.0/24)" >&2
    exit 2
  fi
  printf '%s' "$found"
}

own() { printf '%s\n' -s "$1" -d "$1" -m comment --comment "$TAG" -j RETURN; }
wall() { printf '%s\n' -s "$1" -d "$2" -m conntrack --ctstate NEW -m comment --comment "$TAG" -j DROP; }

have() { mapfile -t rule < <("$@"); iptables -C "$CHAIN" "${rule[@]}" 2>/dev/null; }

# Номер строки первого правила подсети в `iptables -S`, которое кончается данным действием.
line_of() { iptables -S "$CHAIN" | grep -n -- "-s $1 .*--comment $TAG -j $2\$" | head -1 | cut -d: -f1; }

apply() {
  local net="$1" range rule
  # Цепочку создаёт docker; без него её нет, и ставить правила некуда — единица ждёт docker.service.
  iptables -nL "$CHAIN" >/dev/null 2>&1 || { echo "Цепочки $CHAIN нет: docker не запущен?" >&2; exit 1; }
  for range in "${BLOCKED[@]}"; do
    if ! have wall "$net" "$range"; then
      mapfile -t rule < <(wall "$net" "$range")
      iptables -I "$CHAIN" "${rule[@]}"
    fi
  done
  # Исключение своей подсети — первым, выше запретов. Если оно оказалось ниже (запрет пропал и вернулся
  # наверх, правило переставили руками), оно переставляется наверх.
  mapfile -t rule < <(own "$net")
  if iptables -C "$CHAIN" "${rule[@]}" 2>/dev/null && (($(line_of "$net" RETURN) > $(line_of "$net" DROP))); then
    iptables -D "$CHAIN" "${rule[@]}"
  fi
  if ! iptables -C "$CHAIN" "${rule[@]}" 2>/dev/null; then
    iptables -I "$CHAIN" "${rule[@]}"
  fi
  echo "стена плеера страниц для $net поставлена"
}

check() {
  local net="$1" range missing=0
  iptables -nL "$CHAIN" >/dev/null 2>&1 || { echo "Цепочки $CHAIN нет (или нет прав читать iptables)" >&2; exit 1; }
  echo "Правила $CHAIN для подсети плеера страниц $net:"
  iptables -S "$CHAIN" | grep -- "--comment $TAG" | grep -- "-s $net" | sed 's/^/  /' || true
  have own "$net" || { echo "  нет исключения своей подсети"; missing=1; }
  for range in "${BLOCKED[@]}"; do
    have wall "$net" "$range" || { echo "  НЕТ запрета в $range"; missing=1; }
  done
  if ((!missing)) && (($(line_of "$net" RETURN) > $(line_of "$net" DROP))); then
    echo "  исключение своей подсети стоит ниже запретов"
    missing=1
  fi
  if ((missing)); then
    echo "стена плеера страниц для $net — НЕ ПОЛНАЯ: sudo bash infra/sniffer-firewall.sh apply" >&2
    exit 1
  fi
  echo "стена плеера страниц для $net — на месте"
}

remove() {
  local net="$1" range rule
  for range in "${BLOCKED[@]}"; do
    mapfile -t rule < <(wall "$net" "$range")
    while iptables -C "$CHAIN" "${rule[@]}" 2>/dev/null; do iptables -D "$CHAIN" "${rule[@]}"; done
  done
  mapfile -t rule < <(own "$net")
  while iptables -C "$CHAIN" "${rule[@]}" 2>/dev/null; do iptables -D "$CHAIN" "${rule[@]}"; done
  echo "стена плеера страниц для $net убрана"
}

install() {
  local root
  root="$(pwd)"
  if [[ "$(id -u)" != 0 ]]; then
    echo "Стена плеера страниц ставится от root: sudo bash infra/sniffer-firewall.sh --install" >&2
    exit 1
  fi
  if ! command -v systemctl >/dev/null; then
    echo "systemd здесь нет: поставьте правила сейчас (apply) и после каждой перезагрузки сами." >&2
    apply "$(subnet)"
    exit 0
  fi
  sed "s#@CORD_ROOT@#${root}#g" infra/cord-sniffer-firewall.service > /etc/systemd/system/cord-sniffer-firewall.service
  systemctl daemon-reload
  systemctl enable cord-sniffer-firewall.service >/dev/null
  # Правила — сейчас, а не при следующей загрузке: единица oneshot с RemainAfterExit, restart их повторит.
  systemctl restart cord-sniffer-firewall.service
  echo "Стена плеера страниц: cord-sniffer-firewall.service включена. Проверить — sudo bash infra/sniffer-firewall.sh check"
}

case "${1:-}" in
  apply) apply "$(subnet "${2:-}")" ;;
  check) check "$(subnet "${2:-}")" ;;
  remove) remove "$(subnet "${2:-}")" ;;
  --install) install ;;
  *)
    sed -n '3,8p' "$0" | sed 's/^# \?//' >&2
    exit 2
    ;;
esac
