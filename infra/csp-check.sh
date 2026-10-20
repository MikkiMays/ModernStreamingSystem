#!/usr/bin/env bash
# Рамка и CSP по путям шлюза (E09, решение архитектора 17).
#
# Поднимает Caddy шлюза с `infra/Caddyfile` в контейнере без сети, кладёт в `/srv` пустышки
# index.html и tg.html и спрашивает заголовки по путям:
#   /tg и /tg/ — `frame-ancestors https://web.telegram.org`, без `X-Frame-Options`, тело — tg.html;
#   всё остальное — `frame-ancestors 'none'` и `X-Frame-Options DENY`.
# Остальная политика у всех одна — сверяется, что она не разошлась.
#
#   bash infra/csp-check.sh                     # образ шлюза compose (после `docker compose build`)
#   GATEWAY_IMAGE=caddy:2.11.4-alpine bash infra/csp-check.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
image="${GATEWAY_IMAGE:-modern-streaming-gateway}"
site="$(mktemp -d)"
trap 'rm -rf "$site"' EXIT
chmod 755 "$site"
printf '<!doctype html><title>index</title>CORD-INDEX\n' >"$site/index.html"
printf '<!doctype html><title>tg</title>CORD-TG\n' >"$site/tg.html"
chmod 644 "$site"/*.html

paths=(/ /tg /tg/ /tg.html /tgx /room/00000000-0000-0000-0000-000000000000 /download /join/123456789 /assets/x.js)

# Ответы — в один вывод: `== путь`, заголовки, первая строка тела. Сеть контейнеру не нужна: шлюз
# и запросы — на его же 127.0.0.1.
output="$(
  docker run --rm --network none \
    -e APP_HOST=cord.test -e RTC_HOST=rtc.cord.test -e PUBLIC_URL=https://cord.test \
    -e INTERNAL_SECRET=csp-check-secret-csp-check-secret -e GATEWAY_PORT=18091 -e HOOKS_PORT=18090 \
    -v "$root/infra/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$site:/srv:ro" \
    --entrypoint sh "$image" -c '
      caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/caddy.log 2>&1 &
      for _ in $(seq 50); do wget -q -O /dev/null --header "Host: cord.test" http://127.0.0.1:18091/ 2>/dev/null && break; sleep 0.2; done
      for path in '"${paths[*]}"'; do
        echo "== $path"
        wget -S -O /tmp/body --header "Host: cord.test" "http://127.0.0.1:18091$path" 2>&1 | grep -iE "^ +(content-security-policy|x-frame-options):" || true
        head -c 200 /tmp/body 2>/dev/null | tr -d "\n"; echo
        rm -f /tmp/body
      done
    '
)"

fail=0
check() { # путь, условие словами, команда
  local path="$1" what="$2"
  shift 2
  if ! "$@"; then
    echo "НЕ ТАК: $path — $what" >&2
    fail=1
  fi
}
block() { awk -v p="== $1" '$0 == p {on = 1; next} /^== / {on = 0} on' <<<"$output"; }
policy() { block "$1" | grep -i 'content-security-policy:' | sed 's/^ *[Cc]ontent-[Ss]ecurity-[Pp]olicy: *//'; }
has() { grep -qiF -- "$2" <<<"$1"; }
lacks() { ! grep -qiF -- "$2" <<<"$1"; }

none_tail="; frame-ancestors 'none'"
telegram_tail="; frame-ancestors https://web.telegram.org"
base="$(policy /)"
base="${base%"$none_tail"}"
check / "базовая политика прочитана" test -n "$base"

for path in "${paths[@]}"; do
  headers="$(block "$path")"
  csp="$(policy "$path")"
  check "$path" "одна политика CSP" test "$(grep -ci 'content-security-policy:' <<<"$headers")" = 1
  case "$path" in
    /tg | /tg/)
      check "$path" "frame-ancestors https://web.telegram.org" has "$csp" "frame-ancestors https://web.telegram.org"
      check "$path" "без 'none'" lacks "$csp" "frame-ancestors 'none'"
      check "$path" "без X-Frame-Options" lacks "$headers" "x-frame-options"
      check "$path" "отдаёт tg.html" has "$headers" "CORD-TG"
      check "$path" "остальная политика та же" test "${csp%"$telegram_tail"}" = "$base"
      ;;
    *)
      check "$path" "frame-ancestors 'none'" has "$csp" "frame-ancestors 'none'"
      check "$path" "без web.telegram.org" lacks "$csp" "web.telegram.org"
      check "$path" "X-Frame-Options DENY" has "$headers" "x-frame-options: deny"
      check "$path" "остальная политика та же" test "${csp%"$none_tail"}" = "$base"
      ;;
  esac
done

if [ "$fail" != 0 ]; then
  echo "$output" >&2
  exit 1
fi
echo "CSP и рамка по путям — как задумано: ${#paths[@]} путей, /tg и /tg/ — только web.telegram.org"
