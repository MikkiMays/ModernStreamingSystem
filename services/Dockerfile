# The music publisher is a separate program because the Python client cannot ask for a
# stereo track: `TrackPublishOptions` has no such field there, the server negotiates one
# channel, and the room hears every record folded into mono. Go's SDK has it.
FROM golang:1.26-bookworm@sha256:9fdc884aacc3bec89b20ffc69f4bb369c78210e3e4f600387b5128b12c199f81 AS publisher
WORKDIR /src
COPY services/publisher/go.mod services/publisher/go.sum ./
RUN go mod download
COPY services/publisher/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o /cord-publisher .

FROM python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 cord && useradd --uid 10001 --gid cord --no-create-home cord
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 XDG_CONFIG_HOME=/tmp/cord-config
WORKDIR /app
COPY services/requirements.lock ./requirements.lock
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY --from=publisher /cord-publisher /usr/local/bin/cord-publisher
COPY services/cord_services ./cord_services
USER 10001:10001
CMD ["uvicorn", "cord_services.app:create_app", "--factory", "--host", "127.0.0.1", "--port", "18100", "--no-access-log", "--log-level", "warning"]
