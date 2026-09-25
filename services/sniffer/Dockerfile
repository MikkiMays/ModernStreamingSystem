# Плеер страниц кинозала (`services/sniffer`): headless Chromium Playwright открывает страницу, которую не
# понял yt-dlp, и записывает, какой поток спросил её плеер. Собирается из корня репозитория: охраняемый
# выход и защита «только наружу» — тот же код, что у службы (`cord_services/cinema`), одной копией.
FROM python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254 AS base
# HOME и кэши — во временной памяти: корень контейнера только для чтения, а браузеру и шрифтам есть что
# записать. Браузеры Playwright — в образе, по пути, который знает и сборка, и запуск.
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    HOME=/tmp XDG_CACHE_HOME=/tmp/.cache XDG_CONFIG_HOME=/tmp/.config
WORKDIR /app
COPY services/sniffer/requirements.lock ./requirements.lock
# Только headless shell Chromium (`--only-shell`): полный браузер с окнами здесь не нужен. Его версию
# закрепляет версия Playwright в requirements.lock. tini запускает `entry.py` сам (см. его описание).
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates \
    && pip install --no-cache-dir --require-hashes -r requirements.lock \
    && playwright install --with-deps --only-shell chromium \
    && ln -s "$(ls -d /opt/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64)/chrome-headless-shell" \
        /opt/chrome-headless-shell \
    && test -x /opt/chrome-headless-shell \
    && rm -rf /var/lib/apt/lists/* /tmp/* \
    && groupadd --gid 10001 cord && useradd --uid 10001 --gid cord --no-create-home cord
# Из кинозала службы — только выход, его защита и разбор ссылки; пакеты с пустыми `__init__`, чтобы не
# тянуть за ними фасад кинозала со всеми его зависимостями.
COPY services/cord_services/cinema/net.py services/cord_services/cinema/egress.py \
    services/cord_services/cinema/address.py ./cord_services/cinema/
RUN touch cord_services/__init__.py cord_services/cinema/__init__.py
COPY --chmod=0755 services/sniffer/chrome.sh ./chrome.sh
COPY services/sniffer/sniffer ./sniffer

# Тесты плеера страниц: страницы-фикстуры служат сами тесты, внутри контейнера и без сети. hls.js — той же
# версии и с той же подписью, что у веба; поток — тот же HLS, что у e2e веба.
FROM base AS test
COPY services/sniffer/tests/fixtures/hlsjs.py /tmp/hlsjs.py
RUN python /tmp/hlsjs.py /opt/fixtures && rm /tmp/hlsjs.py
COPY web/e2e/fixtures/hls /opt/fixtures/hls
COPY services/sniffer/tests /tests
USER 10001:10001
ENTRYPOINT ["python", "-m", "unittest", "discover", "-s", "/tests"]
CMD ["-v"]

FROM base AS sniffer
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["python", "-m", "sniffer.entry"]
