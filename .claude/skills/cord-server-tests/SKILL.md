---
name: cord-server-tests
description: Use when changing Java code under server/, Python under services/ or Go under services/publisher in Cord, or when a CI "core"/"deployment-config" job is red — the host has no JDK and CI is stricter than a plain local test run.
---

# Тесты ядра и служб Cord без JDK на хосте

## Главное

На машине нет `java`/`mvn` — всё в контейнерах. CI запускает **`fmt:check verify`**, а не просто `test`:
google-java-format валит новые файлы почти всегда, поэтому сначала форматировать.

## Быстрые команды (из корня `ModernStreamingSystem`)

| Что | Команда |
| --- | --- |
| Отформатировать Java | `docker run --rm -v cord-m2:/root/.m2 -v "$PWD":/w -w /w maven:3.9.11-eclipse-temurin-25 mvn -B -q -pl server com.spotify.fmt:fmt-maven-plugin:format` |
| Один класс тестов | то же, `mvn -B -pl server test -Dtest=DurakTest` (можно `-Dtest='DurakTest#transfer*'`) |
| Как в CI | то же, `mvn -B -pl server fmt:check verify` + для Testcontainers: `-v /var/run/docker.sock:/var/run/docker.sock -e TESTCONTAINERS_HOST_OVERRIDE=172.17.0.1` |
| Тесты служб | `docker compose run --rm --no-deps --network none --entrypoint python -v "$PWD/services/tests:/tests:ro" -e PYTHONPATH=/app:/tests services -m unittest discover -s /tests` (образ `services` пересобрать после правки кода: код копируется в образ) |
| Один модуль служб | `... -m unittest test_services -v` |
| ruff кинозала | `docker run --rm -v "$PWD/services":/s -w /s ghcr.io/astral-sh/ruff:0.13.2 check cord_services/cinema sniffer tests/test_cinema*.py --line-length 110 --extend-select E501` |
| Go-издатель | `docker run --rm -v "$PWD/services/publisher":/src -w /src -e GOFLAGS=-mod=mod golang:1.26-bookworm sh -c "gofmt -l . && go vet ./... && go test ./..."` |

## Ловушки

- **Непонятная ошибка компиляции у `Contracts`** — добавить `-Dmaven.compiler.fork=true`.
- **Машина медленная** (steal до 50 %): полный `verify` идёт ~35 мин, `FavoriteOrderPostgresTest` может не
  дождаться контейнера Postgres. Во время работы гонять `-Dtest=…`, полный прогон — перед пушем или в CI.
- **Тесты служб с `--network none`** локально зелёные, даже если тест незаметно ходит в сеть; CI сеть
  имеет. Новый тест не должен звать настоящие адреса — подставлять клиента.
- **Новое поле в `RoomState`** — `@JsonInclude(NON_NULL)` (откат образа читает комнаты с `ignoreUnknown`).
- **Новая миграция** — следующий номер `V<n>__*.sql`, работает и на Postgres, и на H2 (MODE=PostgreSQL);
  применённые миграции не переписывать.
- **Новое поле снимка** — три конструктора `Contracts.Snapshot` (`RoomService.snapshot/admission/snapshotFor`)
  и `OpenApiConfig` (required/nullable), затем перегенерировать контракты (скилл `cord-contracts`
  в `backlog/knowledge/codex-skills/`).
- **Новый тип команды** — в `Contracts.COMMAND_TYPES` (тип ≤ 30 знаков); тест всех типов —
  `RoomServiceTest`.
