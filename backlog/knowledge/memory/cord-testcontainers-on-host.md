---
name: cord-testcontainers-on-host
description: "Почему *PostgresTest ядра Cord на стенде молча пропускаются или падают по таймауту, и какой запуск даёт настоящий PostgreSQL"
metadata:
  type: project
---

Тесты ядра с Testcontainers (`FavoriteOrderPostgresTest`, `FavoriteGroupsPostgresTest`) гоняются из
контейнера `maven:3.9.11-eclipse-temurin-25`, а Postgres для них поднимается соседним контейнером через
`/var/run/docker.sock`. На машине `cord.nikg.tech` (19.10.2026, E02) два прежних способа не работают:

- с `-e TESTCONTAINERS_HOST_OVERRIDE=172.17.0.1` помощник Ryuk не успевает подняться на медленном хосте,
  `@Testcontainers(disabledWithoutDocker = true)` превращает это в **пропуск** — сборка зелёная, а
  PostgreSQL не проверялся ни одним тестом (смотреть `Tests run … Skipped` в выводе);
- с `TESTCONTAINERS_RYUK_DISABLED=true`, но в сети Docker по умолчанию — `SocketTimeoutException:
  Connect timed out`: проброшенный порт Postgres на `172.17.0.1` из такого контейнера недоступен.

Рабочий запуск — контейнер maven в сети хоста и без Ryuk:

```
docker run --rm --network host -v cord-m2:/root/.m2 -v /var/run/docker.sock:/var/run/docker.sock \
  -e TESTCONTAINERS_RYUK_DISABLED=true -v "$PWD":/w -w /w maven:3.9.11-eclipse-temurin-25 \
  mvn -B -pl server fmt:check test -Dtest=FavoriteGroupsPostgresTest -Dsurefire.failIfNoSpecifiedTests=false
```

Без Ryuk контейнеры убирает сам Testcontainers по завершении; после прерванного прогона проверить
`docker ps` на осиротевшие `postgres@sha256:…`.
