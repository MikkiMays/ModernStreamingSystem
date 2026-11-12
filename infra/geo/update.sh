#!/usr/bin/env bash
# Базы адресов для службы аналитики `insight` (R239, docs/architecture/analytics-v2.md §4.4).
#
# ЧТО ДЕЛАЕТ. Скачивает в каталог баз (`GEO_DIR`, по умолчанию `.local/geo` установки):
#   dbip-country-lite.mmdb, dbip-asn-lite.mmdb — DB-IP Lite текущего месяца (страна и ASN адреса);
#   hosting-asn.txt — ASN дата-центров и выходов VPN (`brianhama/bad-asn-list`);
#   mobile-asn.txt — ASN мобильных операторов, копия `infra/geo/mobile-asn.txt` из репозитория.
# Источники и лицензии — в `infra/geo/README.md`.
#
# КАК ПОДХВАТЫВАЕТ СЛУЖБА. Каталог подключён в контейнер `insight` только для чтения (`/geo`); служба раз в
# минуту смотрит на время изменения файлов и перечитывает их сама — перезапуск не нужен. Файл заменяется
# переименованием: служба никогда не видит его наполовину записанным. Нет файлов — служба работает, страна
# и сеть — «неизвестно».
#
# ЗАПУСК.
#   bash infra/geo/update.sh             — обновить базы сейчас;
#   sudo bash infra/geo/update.sh install — поставить таймер systemd `cord-geo.timer` (3-го и 17-го числа);
#   проверить: docker compose exec insight /cord-insight geo 8.8.8.8
#
# Скрипт ничего не шлёт о сервере: только скачивает публичные файлы.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
dir=${GEO_DIR:-$root/.local/geo}

if [ "${1:-}" = "install" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "Таймер ставит root: sudo bash infra/geo/update.sh install" >&2
    exit 1
  fi
  for unit in cord-geo.service cord-geo.timer; do
    sed "s#@CORD_ROOT@#${root}#g" "$here/$unit" > "/etc/systemd/system/$unit"
  done
  systemctl daemon-reload
  systemctl enable --now cord-geo.timer
  echo "Базы адресов: обновление 3-го и 17-го числа. Посмотреть — systemctl list-timers cord-geo.timer"
  exit 0
fi

mkdir -p "$dir"
tmp=$(mktemp -d "$dir/.update.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

fetch() {
  curl --fail --silent --show-error --location --retry 3 --max-time 600 --user-agent "geo-update" --output "$2" "$1"
}

# Поставить файл на место переименованием; права — читать всем: служба в контейнере идёт под своим uid.
place() {
  chmod 0644 "$1"
  mv -f "$1" "$dir/$2"
}

# DB-IP Lite: файл месяца выкладывают в его первые дни; нет текущего — годится прошлый.
dbip() {
  local kind=$1 month
  for month in "$(date -u +%Y-%m)" "$(date -u -d "$(date -u +%Y-%m-15) -1 month" +%Y-%m)"; do
    if fetch "https://download.db-ip.com/free/dbip-$kind-lite-$month.mmdb.gz" "$tmp/$kind.mmdb.gz" 2>/dev/null; then
      gzip -dc "$tmp/$kind.mmdb.gz" > "$tmp/$kind.mmdb"
      # База MMDB кончается сведениями о себе с меткой MaxMind.com: так видно, что скачалась база, а не
      # страница с извинениями. И она не бывает маленькой.
      if grep -aq 'MaxMind.com' "$tmp/$kind.mmdb" && [ "$(stat -c %s "$tmp/$kind.mmdb")" -gt 1000000 ]; then
        place "$tmp/$kind.mmdb" "dbip-$kind-lite.mmdb"
        echo "dbip-$kind-lite.mmdb: $month"
        return 0
      fi
      echo "dbip-$kind-lite-$month: скачалось не то, что ожидалось" >&2
    fi
  done
  echo "dbip-$kind-lite: не скачать ни за текущий месяц, ни за прошлый — прежний файл оставлен" >&2
  return 1
}

# ASN хостеров: CSV `ASN,Entity` → строки `AS12345 # имя`, как их читает служба.
hosting() {
  fetch "https://raw.githubusercontent.com/brianhama/bad-asn-list/master/bad-asn-list.csv" "$tmp/hosting.csv" || return 1
  {
    echo "# ASN дата-центров и выходов VPN: brianhama/bad-asn-list, лицензия MIT. Обновлено $(date -u +%Y-%m-%d)."
    awk -F, 'NR > 1 && $1 ~ /^[0-9]+$/ { name = $0; sub(/^[0-9]+,/, "", name); gsub(/"/, "", name); print "AS" $1 " # " name }' "$tmp/hosting.csv" | sort -u -t' ' -k1,1
  } > "$tmp/hosting-asn.txt"
  # В списке сотни строк; десяток — это не список, а ошибка.
  if [ "$(grep -c '^AS' "$tmp/hosting-asn.txt")" -lt 300 ]; then
    echo "hosting-asn.txt: в скачанном списке подозрительно мало строк — прежний файл оставлен" >&2
    return 1
  fi
  place "$tmp/hosting-asn.txt" hosting-asn.txt
  echo "hosting-asn.txt: $(grep -c '^AS' "$dir/hosting-asn.txt") ASN"
}

failed=0
dbip country || failed=1
dbip asn || failed=1
hosting || failed=1
cp "$here/mobile-asn.txt" "$tmp/mobile-asn.txt" && place "$tmp/mobile-asn.txt" mobile-asn.txt
echo "mobile-asn.txt: $(grep -c '^AS' "$dir/mobile-asn.txt") ASN"
echo "Каталог баз: $dir"
exit "$failed"
