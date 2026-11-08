# Служба `fleet` — пульт флота на A (R207, Р-112). Лёгкий образ: python-slim + клиент SSH; ни ffmpeg, ни
# yt-dlp, ни кода продукта. Та же база и тот же пользователь 10001, что у `services/Dockerfile`.
FROM python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254 AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 cord && useradd --uid 10001 --gid cord --no-create-home cord
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY services/fleet/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY services/fleet/fleet ./fleet
RUN chmod -R u=rwX,go=rX fleet

# Тесты службы — тем же образом, что идёт на сервер: `docker build --target test` + `docker run --network none`.
FROM base AS test
COPY services/fleet/tests ./tests
RUN chmod -R u=rwX,go=rX tests
USER 10001:10001
ENV FLEET_DATA=/tmp/fleet
CMD ["python", "-m", "unittest", "discover", "-s", "tests", "-t", ".", "-v"]

FROM base AS fleet
USER 10001:10001
# Состояние — том `fleet-data` (/data); ключи SSH — том `/keys` только для чтения (Р-120).
CMD ["python", "-m", "fleet.app"]
