#!/usr/bin/env bash
# Cord — обновление сервера одной командой.
#
#   ./update.sh               обновить всё: код, образы, конфигурацию
#   ./update.sh --check       посмотреть, что изменилось; ничего не трогать
#   ./update.sh --yes         без вопросов, для cron и скриптов
#   ./update.sh --force       пересобрать, даже если ничего не изменилось
#   ./update.sh --keep-calls  не трогать SFU: идущие звонки переживут обновление
#
# ПОЧЕМУ НЕ «git pull && docker compose up -d». Эта пара команд пересобирает всё подряд,
# включая службу, которую не меняли, и перезапускает вообще все контейнеры — вместе с
# базой. А главное, она ничего не проверяет: если новая сборка не поднимется, сервер
# останется лежать, и вернуть его будет нечем.
#
# Здесь пересобирается только то, что действительно изменилось; прежние образы помечаются
# `cord-rollback-*` ДО сборки, и если после перезапуска сервер не отвечает — скрипт сам
# возвращает их обратно. Данные не удаляются ни при каком исходе: `docker compose down -v`
# тут нет и быть не может.
#
# Обновление перезапускает SFU, поэтому идущие звонки оборвутся. Это нормально: разговор
# начнут заново. Кому это дорого — `--keep-calls`, он пропустит всё, что трогает медиа,
# и скажет, что осталось доделать.
# -E: ловушка отката должна срабатывать и внутри функций, иначе неудачный перезапуск
# молча оставит сервер наполовину обновлённым.
set -Eeuo pipefail

CHECK=0 ASSUME_YES=0 FORCE=0 KEEP_CALLS=0
NODE_IMAGE="node:22-alpine"

die() { printf '\n\033[31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '    \033[33m%s\033[0m\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --force) FORCE=1; shift ;;
    --keep-calls) KEEP_CALLS=1; shift ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) die "Неизвестный параметр: $1" ;;
  esac
done

[[ -f compose.yaml ]] || die "Запускайте из каталога ModernStreamingSystem."
[[ -f .env ]] || die "Здесь нет .env — сервер ещё не установлен. Сначала ./setup.sh"
command -v git >/dev/null || die "Нужен git."
git rev-parse --git-dir >/dev/null 2>&1 || die "Это не git-репозиторий: обновлять нечего."
docker compose version >/dev/null 2>&1 || die "Нужен Docker с Compose v2. Возможно, нужен sudo."

step "Смотрим, что изменилось"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
REMOTE="$(git config "branch.$BRANCH.remote" || echo origin)"
git fetch --quiet "$REMOTE" "$BRANCH" || die "Не удалось получить обновления от $REMOTE."
BEFORE="$(git rev-parse HEAD)"
TARGET="$(git rev-parse FETCH_HEAD)"
note "Ветка $BRANCH, установлено ${BEFORE:0:7}"

if [[ "$BEFORE" == "$TARGET" ]]; then
  note "Это последняя версия."
  (( FORCE || CHECK )) || exit 0
else
  note "Доступно ${TARGET:0:7} — на $(git rev-list --count "$BEFORE..$TARGET") коммит(ов) вперёд:"
  git --no-pager log --oneline --no-decorate "$BEFORE..$TARGET" | head -15 | sed 's/^/      /'
fi

# Что затронуто. Пересобирать службу, исходники которой не менялись, незачем.
CHANGED="$(git diff --name-only "$BEFORE" "$TARGET" 2>/dev/null || true)"
touched() { grep -Eq "$1" <<<"$CHANGED"; }
REBUILD=()
if (( FORCE )); then
  REBUILD=(gateway core services sniffer)
else
  touched '^(web/|infra/Dockerfile\.web|infra/Caddyfile)' && REBUILD+=(gateway)
  touched '^(server/|pom\.xml|infra/Dockerfile\.server)' && REBUILD+=(core)
  # Плеер страниц кинозала собирается из services/ (охраняемый выход у него общий со службой).
  touched '^services/' && REBUILD+=(services sniffer)
fi
REGENERATE=0; touched '^scripts/(configure|edge-config)\.mjs' && REGENERATE=1
# Стена сети плеера страниц: скрипт и его единицы systemd. Скрипт единицы зовут по пути, и его правка доходит
# сама, а вот файлы единиц (и новая единица — таймер) лежат копией в /etc/systemd/system, и раньше их ставили,
# только если стены не было вовсе: правка единицы до работающего сервера не доезжала никогда. `--install`
# повторяем — переписывает единицы своими файлами и ставит стену заново, — поэтому правка любого из них — повод
# поставить заново.
WALL=0; touched '^infra/(cord-sniffer-|sniffer-firewall\.sh)' && WALL=1
(( FORCE )) && WALL=1
# compose.yaml: пересоздаётся ровно то, у чего поменялась конфигурация. Меряем тем же хешем, по которому
# compose сам решает, пересоздавать ли контейнер (`config --hash '*'`), — до и после, у каждой службы.
# Медиа и базы (INFRA_SERVICES) идут прежним путём — с обрывом звонков, если поменялись они сами; свои
# службы — `up -d --no-deps` по одной (сборка — у тех, у кого она есть; `volume-init` — только пересоздание,
# раньше его изменения доезжали вместе с перезапуском баз). Посчитать не вышло — как раньше: всё сразу.
#
# ЧЕГО ХЕШ НЕ ВИДИТ: блок `build:` (context, dockerfile, target, args). Правка только его — без правки
# исходников службы — пересборку сама не вызовет; обычно вместе с ним меняются и исходники (services/, web/,
# server/, infra/Dockerfile.*), и тогда служба пересобирается по ним. Если нет — руками:
# `docker compose build <служба> && docker compose up -d --no-deps <служба>` (или `./update.sh --force`,
# но он пересобирает всё и перезапускает SFU).
INFRA_SERVICES=' edge livekit postgres redis tusd '
APP_BUILT=' gateway core services sniffer '
config_hashes() {
  git show "$1:compose.yaml" 2>/dev/null \
    | docker compose -f - --project-directory . config --hash '*' 2>/dev/null
}
INFRA=0
RECREATE=()
if touched '^compose\.yaml$'; then
  before_hash="$(config_hashes "$BEFORE" || true)"
  after_hash="$(config_hashes "$TARGET" || true)"
  if [[ -z "$before_hash" || -z "$after_hash" ]]; then
    warn "Не удалось сравнить compose.yaml по службам — обновляется всё, как раньше."
    changed_services="edge livekit postgres redis tusd gateway core services sniffer volume-init"
  else
    # Строки «служба хеш», которых не было до: изменённые и новые службы. Убранные — не трогаются.
    changed_services="$(comm -13 <(sort <<<"$before_hash") <(sort <<<"$after_hash") | awk '{print $1}')"
  fi
  for service in $changed_services; do
    if [[ "$INFRA_SERVICES" == *" $service "* ]]; then
      INFRA=1
    elif [[ "$APP_BUILT" == *" $service "* ]]; then
      [[ " ${REBUILD[*]} " == *" $service "* ]] || REBUILD+=("$service")
    else
      RECREATE+=("$service")
    fi
  done
fi
(( FORCE )) && INFRA=1

if (( ${#REBUILD[@]} )); then note "Пересобрать: ${REBUILD[*]}"; else note "Пересобирать нечего."; fi
(( ${#RECREATE[@]} )) && note "Пересоздать по новой конфигурации: ${RECREATE[*]}"
(( REGENERATE )) && note "Перевыпустить конфигурацию: да (генератор изменился)"
(( WALL )) && note "Поставить заново стену сети плеера страниц: да (скрипт или единицы изменились)"
(( INFRA )) && note "Обновить образы БД/SFU/tusd: да"

# Медиа трогается, если меняли конфигурацию SFU или его образ.
RESTART_MEDIA=0
(( REGENERATE || INFRA )) && RESTART_MEDIA=1
if (( RESTART_MEDIA )); then
  if (( KEEP_CALLS )); then
    warn "Идущие звонки сохраняются, поэтому SFU и edge останутся прежними."
    warn "Их часть обновления придётся доделать отдельно — скрипт напомнит в конце."
  else
    warn "SFU будет перезапущен: идущие звонки оборвутся. Разговор начнут заново."
  fi
fi

if (( CHECK )); then
  note "Это была проверка: ничего не изменено."
  exit 0
fi

NOTHING_TO_DO=0
(( ! ${#REBUILD[@]} )) && (( ! ${#RECREATE[@]} )) && (( ! REGENERATE )) && (( ! INFRA )) && (( ! WALL )) \
  && NOTHING_TO_DO=1

# Стену сети плеера страниц проверяет iptables, а ставит systemd — это root. Без root проверка «не прошла» бы,
# и работающий плеер страниц остановился бы зря, — поэтому отказ сразу, пока ничего не тронуто.
if (( ! NOTHING_TO_DO )) && (( EUID != 0 )) \
  && [[ WALL -eq 1 || " ${REBUILD[*]} " == *" sniffer "* || -n "$(docker compose ps -q sniffer 2>/dev/null)" ]]; then
  die "Плеер страниц работает только за стеной сети, а её проверяет iptables и ставит systemd — нужен root: sudo ./update.sh. Ничего не изменено."
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  warn "В отслеживаемых файлах есть свои правки:"
  git status --short --untracked-files=no | sed 's/^/      /'
  warn "Слияние может не пройти. Сохранить их: git stash"
  (( ASSUME_YES )) || { read -rp "    Продолжить? [y/N] " answer; [[ "$answer" == [yY] ]] || exit 1; }
fi

if (( ! ASSUME_YES )) && (( ! NOTHING_TO_DO )); then
  read -rp $'\n    Обновить? [y/N] ' answer
  [[ "$answer" == [yY] ]] || { note "Отменено."; exit 1; }
fi

if [[ "$BEFORE" != "$TARGET" ]]; then
  step "Забираем изменения"
  git merge --ff-only "$TARGET" >/dev/null \
    || die "Ветка разошлась с $REMOTE. Разберитесь вручную: git status"
  note "Теперь $(git rev-parse --short HEAD)"
fi
if (( NOTHING_TO_DO )); then
  note "Изменились только документы или тесты — перезапускать нечего."
  exit 0
fi

# Метки для отката ставятся ДО сборки: после неё :latest указывает уже на новое.
ROLLBACK_TAG="cord-rollback-$(date +%Y%m%d-%H%M%S)"
TAGGED=()
if (( ${#REBUILD[@]} )); then
  step "Помечаем нынешние образы на случай отката"
  for service in "${REBUILD[@]}"; do
    image="$(docker compose images -q "$service" 2>/dev/null | head -1 || true)"
    if [[ -n "$image" ]]; then
      docker tag "$image" "$ROLLBACK_TAG-$service:latest"
      TAGGED+=("$service")
      note "$service → $ROLLBACK_TAG-$service"
    fi
  done
  # Прежние наборы отката здесь и заканчиваются. Откат — это «вернуть то, что работало
  # минуту назад», и такой набор ровно один: тот, что мы только что пометили. Всё, что
  # осталось от прошлых обновлений, с этого момента не откат, а полтора гигабайта на
  # каждое. Раньше здесь печаталось «удалите, когда убедитесь, что всё в порядке» — и не
  # удалял никто: к следующему дню про это забывают, а девять таких наборов съели 6 ГБ.
  for image in $(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep '^cord-rollback-' | grep -v "^$ROLLBACK_TAG-"); do
    docker rmi "$image" >/dev/null 2>&1 && note "убран прежний откат: $image"
  done
fi

rollback() {
  printf '\n\033[31m==>\033[0m \033[1mВозвращаем прежние образы\033[0m\n'
  for service in "${TAGGED[@]}"; do
    docker tag "$ROLLBACK_TAG-$service:latest" "modern-streaming-$service:latest" || true
    # Плеер страниц и при откате запускается только за стеной сети.
    if [[ "$service" == sniffer ]] && ! bash infra/sniffer-firewall.sh check >/dev/null 2>&1; then
      warn "sniffer: образ возвращён, но стены сети нет — не запускается"
      continue
    fi
    docker compose up -d --no-deps "$service" || true
    note "$service возвращён"
  done
  warn "Сервер работает на прежних образах. Код уже обновлён;"
  warn "откатить и его: git reset --hard $BEFORE"
}

if (( REGENERATE )) && (( ! KEEP_CALLS )); then
  step "Перевыпускаем конфигурацию"
  # `.env` генератор не трогает: секреты и живые сессии переживают обновление. А соседние
  # сайты на том же 443 записаны только в infra/generated/topology.json — без него генератор
  # откажется работать и скажет, чего ему не хватает. Молча портить чужой сайт нельзя.
  BACKUP="infra/generated.before-$(date +%Y%m%d-%H%M%S)"
  cp -a infra/generated "$BACKUP"
  if command -v node >/dev/null; then
    node scripts/configure.mjs --refresh || die "Не удалось перевыпустить конфигурацию."
  else
    docker run --rm -v "$PWD:/w" -w /w "$NODE_IMAGE" \
      sh -c 'apk add --no-cache openssl >/dev/null && node scripts/configure.mjs --refresh' \
      || die "Не удалось перевыпустить конфигурацию."
  fi
  note "Прежние конфиги рядом: $BACKUP"
fi

if (( ${#REBUILD[@]} )); then
  step "Собираем: ${REBUILD[*]}"
  note "Сборка services и sniffer идёт 5–10 минут в первый раз; дальше слои берутся из кэша."
  CORD_BUILD="$(git rev-parse --short HEAD)" docker compose build "${REBUILD[@]}" \
    || { warn "Сборка не удалась. Работающий сервер не тронут."; exit 1; }
fi

if (( INFRA )) && (( ! KEEP_CALLS )); then
  step "Обновляем образы инфраструктуры"
  docker compose pull --quiet postgres redis livekit tusd edge || true
fi

# Плеер страниц открывает чужие страницы в браузере без его песочницы: работает он только за стеной сети
# (`infra/sniffer-firewall.sh`). Её нет (правила сняли, единица не поставилась) или изменились сам скрипт стены
# и её единицы (WALL) — ставим заново; не вышло — остальное обновляется, а плеер страниц останавливается и не
# запускается.
if (( WALL )) || [[ " ${REBUILD[*]} " == *" sniffer "* || -n "$(docker compose ps -q sniffer 2>/dev/null)" ]]; then
  step "Стена сети плеера страниц"
  if (( WALL )) || ! systemctl is-enabled cord-sniffer-firewall.service >/dev/null 2>&1 \
    || ! systemctl is-enabled cord-sniffer-wall.timer >/dev/null 2>&1; then
    bash infra/sniffer-firewall.sh --install || true
  fi
  if ! bash infra/sniffer-firewall.sh check >/dev/null 2>&1; then
    bash infra/sniffer-firewall.sh apply >/dev/null 2>&1 || true
  fi
  if bash infra/sniffer-firewall.sh check >/dev/null 2>&1; then
    note "на месте (sudo bash infra/sniffer-firewall.sh check)"
  else
    warn "Стены нет — плеер страниц остановлен и не запускается. Поставить: sudo bash infra/sniffer-firewall.sh --install"
    kept=()
    for service in "${REBUILD[@]}"; do [[ "$service" == sniffer ]] || kept+=("$service"); done
    REBUILD=("${kept[@]}")
    # И откат его не поднимет: без стены прежний образ не лучше нового.
    kept=()
    for service in "${TAGGED[@]}"; do [[ "$service" == sniffer ]] || kept+=("$service"); done
    TAGGED=("${kept[@]}")
    docker compose stop sniffer >/dev/null 2>&1 || true
  fi
fi

step "Перезапускаем"
trap 'rollback; exit 1' ERR
# Одноразовые службы (`volume-init`) — первыми, и дождаться, пока доделают: остальные ждут того, что они
# делают с томами (раньше их так же дожидался `depends_on` при перезапуске баз). Код не 0 — откат.
ONESHOT_SERVICES=' volume-init '
for service in "${RECREATE[@]}"; do
  docker compose up -d --no-deps "$service"
  if [[ "$ONESHOT_SERVICES" == *" $service "* ]]; then
    docker compose wait "$service" >/dev/null
  fi
  note "$service"
done
for service in "${REBUILD[@]}"; do
  docker compose up -d --no-deps "$service"
  note "$service"
done
if (( RESTART_MEDIA )) && (( ! KEEP_CALLS )); then
  # Конфигурацию читают edge и SFU при старте; без пересоздания новые файлы не увидит никто.
  docker compose up -d --force-recreate edge livekit
  note "edge, livekit"
fi
if (( INFRA )) && (( ! KEEP_CALLS )); then
  docker compose up -d postgres redis tusd
  note "postgres, redis, tusd"
fi
trap - ERR

step "Проверяем"
deadline=$((SECONDS + 120))
healthy=0
while (( SECONDS < deadline )); do
  state="$(docker compose ps --format '{{.Service}} {{.Health}} {{.State}}' 2>/dev/null || true)"
  if ! grep -Eq 'unhealthy|restarting|exited' <<<"$state" && grep -q '^core .*healthy' <<<"$state"; then
    healthy=1; break
  fi
  sleep 3
done
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
if (( ! healthy )); then
  warn "Службы не пришли в порядок за две минуты."
  rollback
  exit 1
fi

ORIGIN="$(sed -n 's/^PUBLIC_URL=//p' .env | head -1)"
if [[ -n "$ORIGIN" ]]; then
  # --insecure: в режиме без домена сертификат самоподписанный, и это не ошибка.
  code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 20 --insecure "$ORIGIN" 2>/dev/null || echo 000)"
  if [[ "$code" == 200 ]]; then
    note "$ORIGIN отвечает 200"
  else
    warn "$ORIGIN ответил $code. Журнал: docker compose logs --tail 50 gateway core"
    rollback
    exit 1
  fi
fi

# Суточная уборка появилась позже самого сервера, и на машинах, поставленных до неё,
# `setup.sh` больше не запускают. Обновление — единственное место, где о ней можно
# вспомнить за хозяина; уже стоящий таймер `--install` просто перезаписывает своими же
# файлами, поэтому проверять «а не стоит ли он уже» незачем.
if ! systemctl is-enabled cord-tidy.timer >/dev/null 2>&1; then
  step "Ставим суточную уборку диска"
  bash infra/tidy.sh --install || warn "Не удалось. Поставить руками: sudo bash infra/tidy.sh --install"
fi
# Стена сети плеера страниц появилась позже самого сервера — так же, как уборка; её таймер — ещё позже.
if ! systemctl is-enabled cord-sniffer-firewall.service >/dev/null 2>&1 \
  || ! systemctl is-enabled cord-sniffer-wall.timer >/dev/null 2>&1; then
  step "Ставим стену сети плеера страниц"
  bash infra/sniffer-firewall.sh --install \
    || warn "Не удалось. Поставить руками: sudo bash infra/sniffer-firewall.sh --install"
fi

step "Готово"
note "Версия: $(git rev-parse --short HEAD)"
if (( ${#TAGGED[@]} )); then
  note "Образы для отката: $ROLLBACK_TAG-*"
  note "Прежние наборы уже убраны; этот уйдёт при следующем обновлении или суточной уборке."
fi
if (( KEEP_CALLS )) && (( RESTART_MEDIA )); then
  warn "Осталось доделать, когда в комнатах никого не будет:"
  warn "  ./update.sh --force            (перевыпустит конфигурацию и обновит SFU)"
fi
note "Клиенты Windows обновятся сами; вкладка в браузере подхватит новое при перезагрузке."
