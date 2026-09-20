#!/usr/bin/env bash
#
# Cord — суточная уборка сервера.
#
#   sudo bash infra/tidy.sh              убрать
#   sudo bash infra/tidy.sh --dry-run    показать, что уйдёт, ничего не трогая
#   sudo bash infra/tidy.sh --install    поставить суточный таймер (это делает setup.sh)
#
# ЗАЧЕМ. Место на диске у Cord не течёт — оно копится ступеньками, и каждая ступенька
# появляется в момент, когда о ней не думают:
#
#   • каждый выпуск клиента Windows кладёт в `.local/windows-releases` 400 МБ и не убирает
#     прошлый — при том что отдаётся наружу только последний. Десять выпусков = 3,9 ГБ;
#   • каждое обновление `update.sh` помечает прежние образы `cord-rollback-*` и печатает
#     «удалите, когда убедитесь». Не удалял никто: девять таких наборов = около 6 ГБ;
#   • каждая пересборка оставляет безымянные слои и кэш сборки;
#   • разовые образы проверок (`cord-audio-probe`, `cord-ux-check-*`) живут вечно.
#
# 13.09.2026 это уже стоило сервера: диск дошёл до 100 % из 126 ГБ, и упал не только Cord,
# а всё на машине. Руками про уборку вспоминают, когда место кончилось, — а кончается оно
# посреди выкатки.
#
# ГЛАВНОЕ ПРАВИЛО: уборка удаляет только то, что умеет вернуться сама.
#
# Выпуск качается из GitHub, образ собирается из исходников, кэш наполняется сборкой. Всё,
# что не воспроизводится, — база, том вложений, `.env`, сертификаты, `infra/generated` —
# не трогается ни при каких условиях, включая кончающийся диск. Про такие вещи уборка
# только рассказывает в конце.
#
# ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Тушения пожара: журнал, растущий на 65 тысяч строк в секунду,
# успевает убить машину между двумя ночными уборками. Его держит `compose.yaml` —
# `max-size: 20m`, `max-file: 5`, то есть сто мегабайт на службу и потолок сверху, а не
# уборка снизу. Проверка журналов ниже — тревожная лампочка на случай, если этот потолок
# когда-нибудь снимут: она подрезает и говорит об этом вслух.
#
# Запускается таймером `cord-tidy.timer` раз в сутки. Устанавливает его `setup.sh`.
set -uo pipefail

cd "$(dirname "$0")/.."
[[ -f compose.yaml ]] || { echo "Запускать из каталога ModernStreamingSystem." >&2; exit 1; }

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

# ── Установка таймера ────────────────────────────────────────────────────────────
#
# Живёт здесь, а не в `setup.sh`, по одной причине: расписание, служба и то, что они
# запускают, — это одно решение, и разносить его по двум файлам значит однажды поменять
# скрипт и забыть про единицы systemd. Вызывают это и `setup.sh` (новая установка), и
# `update.sh` (сервер, поставленный до того, как уборка появилась).
#
# Отказ установки не должен ронять установку сервера: без таймера Cord работает, просто
# убирать за ним придётся руками — и об этом здесь говорится вслух.
if [[ "${1:-}" == "--install" ]]; then
  root="$(pwd)"
  if [[ "$(id -u)" != 0 ]]; then
    echo "Таймер уборки ставится от root: sudo bash infra/tidy.sh --install" >&2
    exit 0
  fi
  if ! command -v systemctl >/dev/null; then
    echo "systemd здесь нет. Добавьте уборку в cron:" >&2
    echo "  (crontab -l 2>/dev/null; echo \"10 5 * * * cd $root && bash infra/tidy.sh >> /var/log/cord-tidy.log 2>&1\") | crontab -" >&2
    exit 0
  fi
  for unit in cord-tidy.service cord-tidy.timer; do
    sed "s#@CORD_ROOT@#${root}#g" "infra/$unit" > "/etc/systemd/system/$unit" || exit 1
  done
  systemctl daemon-reload || exit 1
  systemctl enable --now cord-tidy.timer || exit 1
  echo "Уборка: ежедневно в 05:10. Посмотреть — systemctl list-timers cord-tidy.timer"
  echo "Что уйдёт в следующий раз — sudo bash infra/tidy.sh --dry-run"
  exit 0
fi

# ── Сколько чего оставлять ───────────────────────────────────────────────────────
#
# KEEP_RELEASES=2. Наружу отдаётся ровно один выпуск — тот, что назван в `latest.json`:
# и страница `/download`, и обновлялка клиента спрашивают только его. Второй остаётся не
# для раздачи, а для человека: вернуть вчерашний установщик, не ходя на GitHub.
KEEP_RELEASES="${CORD_KEEP_RELEASES:-2}"

# KEEP_HOURS=24. Столько живут безымянные слои и кэш сборки. Срок суточный, потому что
# уборка суточная: всё, что короче, убиралось бы не этим проходом, а следующим.
KEEP_HOURS="${CORD_KEEP_HOURS:-24}"

# KEEP_BACKUPS=2. Копии `infra/generated`, которые делает `update.sh` перед перевыпуском
# конфигурации. Весят килобайты, но плодятся с каждым обновлением.
KEEP_BACKUPS="${CORD_KEEP_BACKUPS:-2}"

# LOG_AGE_DAYS=14. Журналы сборок и проверок в `.local` — след от работы руками.
LOG_AGE_DAYS="${CORD_LOG_AGE_DAYS:-14}"

# FLOOR_GB=25. Сколько свободного места у Cord должно быть всегда. Ниже этой отметки
# обычной уборки мало, и включается вторая ступень: уходит и набор отката, и весь кэш
# сборки, и все выпуски кроме отдаваемого. Всё это возвращается — ценой времени сборки.
#
# Откуда число. Потолок самого Cord в установившемся режиме — около 17 ГБ:
# вложения 10 ГиБ (`stream.total-max-bytes`), музыка 2 ГиБ (`services/media.py`), образы
# рабочего набора ~1,9 ГБ, набор отката ~1,5 ГБ, выпуски 0,8 ГБ, журналы 0,8 ГБ, база и
# сертификаты — десятки мегабайт. Двадцать пять оставляет запас на пересборку (образ
# `services` распаковывается почти в гигабайт) и на то, что на машине живёт не только Cord.
FLOOR_GB="${CORD_DISK_FLOOR_GB:-25}"

# Журнал контейнера, при котором стоит забеспокоиться. При `max-size: 20m` в `compose.yaml`
# столько не бывает: это проверка на то, что потолок на месте.
LOG_ALARM_BYTES=$((256 * 1024 * 1024))

RELEASES=.local/windows-releases
COMPOSE_PROJECT=modern-streaming

say() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
warn() { printf '[%s] \033[33m%s\033[0m\n' "$(date '+%F %T')" "$*"; }
run() { if (( DRY )); then say "  СУХОЙ ПРОГОН: $*"; else "$@" >/dev/null 2>&1 || say "  не удалось: $*"; fi; }
free_gb() { df --output=avail -BG / | tail -1 | tr -dc '0-9'; }
human() { numfmt --to=iec "$1" 2>/dev/null || echo "$1 байт"; }

BEFORE_FREE=$(free_gb)
say "уборка Cord начата${DRY:+ (сухой прогон)}; свободно ${BEFORE_FREE} ГБ, порог ${FLOOR_GB} ГБ"

# Образы, занятые контейнерами, — включая остановленные: такой контейнер поднимается тем же
# образом, и убрав его, мы превратим «запустить обратно» в «собрать заново».
#
# Две записи на контейнер, и обе нужны: `.Image` — это слепок (`sha256:…`), `.Config.Image` —
# имя, под которым его запускали. Совпасть может любая из них, и сравнивать поэтому надо с
# ПОЛНЫМ идентификатором образа — отсюда `--no-trunc` там, где перечисляются образы.
busy_images() {
  docker ps -aq 2>/dev/null | xargs -r docker inspect --format '{{.Image}} {{.Config.Image}}' 2>/dev/null | tr ' ' '\n' | sort -u
}
BUSY="$(busy_images)"

# Занят ли образ: по слепку или по имени с тегом.
held() { grep -qx "$1" <<<"$BUSY" || grep -qx "$2" <<<"$BUSY"; }

# ── 1. Выпуски клиента Windows ──────────────────────────────────────────────────
#
# Отдаваемый выпуск защищён отдельно от счёта: он берётся из `latest.json`, а не из
# сортировки. Если счёт когда-нибудь поставят в единицу, а выкладка в этот момент окажется
# наполовину сделанной, уборка не должна унести файл, на который уже ссылается страница.
tidy_releases() {
  local keep="$1" served="" kept=0
  [[ -d "$RELEASES" ]] || return 0
  if [[ -f "$RELEASES/latest.json" ]]; then
    served="$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$RELEASES/latest.json" | head -1)"
  fi
  say "выпуски Windows: оставляю ${keep}${served:+, отдаваемый сейчас $served}"
  while read -r tag; do
    [[ -z "$tag" ]] && continue
    if [[ "$tag" == "$served" ]] || (( kept < keep )); then
      kept=$(( kept + 1 ))
      continue
    fi
    say "  убираю выпуск ${tag} ($(du -sh "$RELEASES/$tag" 2>/dev/null | cut -f1))"
    run rm -rf "${RELEASES:?}/${tag:?}"
  done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -name 'v*' -printf '%f\n' 2>/dev/null | sort -Vr)
}

# ── 2. Образы отката от update.sh ───────────────────────────────────────────────
#
# `update.sh` перед сборкой помечает работающие образы `cord-rollback-<время>-<служба>` и в
# конце печатает «удалите, когда убедитесь, что всё в порядке». Это и есть та строка, на
# которую никогда не хватает следующего дня.
#
# Остаётся ОДИН набор — последний по времени. Он и есть откат: вернуться на две выкатки
# назад не понадобилось ни разу, а весит такой набор как полноценный сервер. Под вторую
# ступень уходит и он: диск, кончившийся в ноль, ломает сильнее, чем пересборка.
tidy_rollbacks() {
  local keep_latest="$1" newest=""
  newest="$(docker images --format '{{.Repository}}' 2>/dev/null | grep -E '^cord-rollback-[0-9]{8}-[0-9]{6}-' | sed -E 's/^(cord-rollback-[0-9]{8}-[0-9]{6})-.*/\1/' | sort -u | tail -1)"
  if (( keep_latest )) && [[ -n "$newest" ]]; then
    say "образы отката: оставляю последний набор ${newest}-*"
  else
    newest=""
    say "образы отката: убираю все"
  fi
  while read -r repo tag id; do
    [[ -z "${repo:-}" ]] && continue
    [[ "$repo" == cord-rollback-* ]] || continue
    [[ -n "$newest" && "$repo" == "$newest"-* ]] && continue
    if held "$id" "${repo}:${tag}"; then
      say "  занят контейнером, пропускаю: ${repo}:${tag}"
      continue
    fi
    say "  убираю откат: ${repo}:${tag}"
    run docker rmi "${repo}:${tag}"
  done < <(docker images --no-trunc --format '{{.Repository}} {{.Tag}} {{.ID}}' 2>/dev/null)
}

# ── 3. Разовые теги своих образов ───────────────────────────────────────────────
#
# У рабочих образов `modern-streaming-*` живёт один тег — `latest`: именно его запускает
# `docker compose up`. Всё прочее с тем же именем — метки, оставшиеся от разовых проверок
# (`before-stream-controls` и подобные). Рядом с ними — образы, собранные под одну задачу:
# слушатель комнаты, проверка интерфейса, зеркало сборки.
#
# Только свои. Чужие образы приходят из реестра и качаются заново — решать за них, какая
# версия лишняя, мы не вправе; на этой машине живёт не только Cord.
tidy_one_off_images() {
  say "разовые образы Cord старше ${KEEP_HOURS} ч"
  local cutoff created
  cutoff=$(( $(date +%s) - KEEP_HOURS * 3600 ))
  while read -r repo tag id; do
    [[ -z "${repo:-}" || "$tag" == "<none>" ]] && continue
    case "$repo" in
      modern-streaming-*) [[ "$tag" == latest ]] && continue ;;
      cord-audio-probe|cord-ux-check-*|cord-mirror-*) ;;
      *) continue ;;
    esac
    # Возраст спрашивается у самого образа и только у кандидатов: `docker images` печатает
    # время в виде «2026-09-17 22:51:09 +0300 MSK», и разбирать это построчно значит
    # зависеть от того, как докер решит его отформатировать в следующей версии.
    created="$(docker image inspect -f '{{.Created}}' "$id" 2>/dev/null)"
    created="$(date -d "$created" +%s 2>/dev/null || echo 0)"
    (( created == 0 || created > cutoff )) && continue
    if held "$id" "${repo}:${tag}"; then
      say "  занят контейнером, пропускаю: ${repo}:${tag}"
      continue
    fi
    say "  убираю разовый тег: ${repo}:${tag}"
    run docker rmi "${repo}:${tag}"
  done < <(docker images --no-trunc --format '{{.Repository}} {{.Tag}} {{.ID}}' 2>/dev/null)
}

# ── 4. Резервные копии конфигурации ─────────────────────────────────────────────
#
# `update.sh` копирует `infra/generated` в `infra/generated.before-<время>` перед каждым
# перевыпуском. Сама `infra/generated` не трогается никогда: в ней сертификаты и настройки
# работающего сервера.
tidy_config_backups() {
  local kept=0
  say "копии конфигурации: оставляю ${KEEP_BACKUPS}"
  while read -r dir; do
    [[ -z "$dir" ]] && continue
    if (( kept < KEEP_BACKUPS )); then kept=$(( kept + 1 )); continue; fi
    say "  убираю копию: ${dir}"
    run rm -rf "${dir:?}"
  done < <(find infra -mindepth 1 -maxdepth 1 -type d -name 'generated.before-*' 2>/dev/null | sort -r)
}

# ── 5. Журналы сборок и проверок ────────────────────────────────────────────────
#
# Только `*.log` и только в самом `.local`, на один уровень вглубь. Рядом там лежит то,
# что уборке не принадлежит: `telegram.env` с секретом, `windows-releases`, слепки и
# окружения, сделанные руками. Их не трогает ни одна ступень.
tidy_build_logs() {
  say "журналы сборок в .local старше ${LOG_AGE_DAYS} дн."
  local freed=0 size
  while IFS= read -r log; do
    [[ -f "$log" ]] || continue
    size=$(stat -c %s "$log" 2>/dev/null || echo 0)
    freed=$(( freed + size ))
    run rm -f "$log"
  done < <(find .local -maxdepth 1 -type f -name '*.log' -mtime "+${LOG_AGE_DAYS}" 2>/dev/null)
  (( freed )) && say "  освобождено $(human "$freed")"
  return 0
}

# ── 6. Журналы контейнеров Cord ─────────────────────────────────────────────────
#
# Тревожная лампочка, а не уборка: при `max-size: 20m` столько не бывает. Подрезание —
# `truncate` живого файла, а не удаление: файл открыт докером, и удалив его, мы получим
# занятое место до перезапуска контейнера и докер, пишущий в никуда. Хвост сохраняется:
# журнал, исчезнувший вместе с причиной, превращает разбор в гадание.
tidy_container_logs() {
  local id name log size
  while read -r id name; do
    [[ -z "${id:-}" ]] && continue
    log="/var/lib/docker/containers/${id}/${id}-json.log"
    [[ -f "$log" ]] || continue
    size=$(stat -c %s "$log" 2>/dev/null || echo 0)
    (( size < LOG_ALARM_BYTES )) && continue
    warn "журнал ${name} вырос до $(human "$size") — потолок из compose.yaml не сработал"
    if (( DRY )); then
      say "  СУХОЙ ПРОГОН: truncate -s 0 ${log}"
    else
      mkdir -p /var/lib/cord-tidy 2>/dev/null
      tail -c 200000 "$log" > "/var/lib/cord-tidy/last-${name}.log" 2>/dev/null
      truncate -s 0 "$log" 2>/dev/null
      say "  подрезан, хвост в /var/lib/cord-tidy/last-${name}.log"
    fi
  done < <(docker ps -a --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
    --format '{{.ID}} {{.Names}}' 2>/dev/null)
}

# ── 7. Безымянные слои и кэш сборки ─────────────────────────────────────────────
#
# Единственное место, где уборка выходит за пределы Cord: кэш сборки у докера общий на всю
# машину. Поэтому здесь только срок — сутки, — и никакого `-a`: с ключом «всё» ушёл бы кэш
# соседних проектов вместе с их временем сборки. Полная очистка есть, но только на второй
# ступени, когда диск уже кончается.
tidy_docker_cache() {
  say "безымянные слои и кэш сборки старше ${KEEP_HOURS} ч"
  run docker image prune -f --filter "until=${KEEP_HOURS}h"
  run docker builder prune -f --filter "until=${KEEP_HOURS}h"
}

tidy_releases "$KEEP_RELEASES"
tidy_rollbacks 1
tidy_one_off_images
tidy_config_backups
tidy_build_logs
tidy_container_logs
tidy_docker_cache

# ── 8. Вторая ступень: диск ниже порога ─────────────────────────────────────────
#
# Сюда доходят, когда обычной уборки не хватило. Всё, что уходит здесь, возвращается
# сборкой или загрузкой с GitHub — но возвращается не мгновенно, и поэтому это не
# ежедневное поведение, а ответ на «место кончается».
AFTER_FREE=$(free_gb)
if (( AFTER_FREE < FLOOR_GB )); then
  warn "свободно ${AFTER_FREE} ГБ — ниже порога ${FLOOR_GB} ГБ. Вторая ступень."
  BUSY="$(busy_images)"
  tidy_releases 1
  tidy_rollbacks 0
  say "весь кэш сборки"
  run docker builder prune -af
  AFTER_FREE=$(free_gb)
fi

say "готово: было ${BEFORE_FREE} ГБ свободно, стало ${AFTER_FREE} ГБ"
df -h / | tail -1 | awk '{print "  диск: занято "$3" из "$2" ("$5"), свободно "$4}'

# ── 9. Что занимает место и осталось нетронутым ─────────────────────────────────
#
# Не всё лишнее уборка вправе убрать. Слепки, сделанные руками, окружения и каталоги
# переноса — это чужая работа, и решать её судьбу должен человек. Отчёт нужен затем, чтобы
# решать было по чему: иначе про эти гигабайты вспоминают там же, где про всё остальное, —
# когда диск кончился.
say "крупное, чего уборка не трогает:"
for path in .local /opt/meet/import /var/lib/docker/volumes/${COMPOSE_PROJECT}_uploads \
            /var/lib/docker/volumes/${COMPOSE_PROJECT}_database; do
  [[ -e "$path" ]] || continue
  say "  $(du -sh "$path" 2>/dev/null | cut -f1)	$path"
done

if (( AFTER_FREE < FLOOR_GB )); then
  warn "места всё ещё меньше порога. Смотреть руками: docker system df, du -sh /opt/*"
  exit 1
fi
exit 0
