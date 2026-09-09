FROM python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 cord && useradd --uid 10001 --gid cord --no-create-home cord
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 XDG_CONFIG_HOME=/tmp/cord-config
WORKDIR /app
COPY services/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY services/cord_services ./cord_services
USER 10001:10001
CMD ["uvicorn", "cord_services.app:create_app", "--factory", "--host", "127.0.0.1", "--port", "18100", "--no-access-log", "--log-level", "warning"]
