---
name: cord-ci-and-release-traps
description: Чем CI в Cord строже локальных команд и как пуш подряд ломает выкладку релиза Windows
metadata: 
  type: project
---

В [[meet-cord-system]] «локально всё зелёное» не значит «CI зелёный»: проверок там больше, и
две из них ловят ровно то, что человек правит руками.

- `./mvnw -pl server verify` **не включает** `fmt:check`. CI запускает
  `mvnw -B -pl server fmt:check verify`, и google-java-format переносит javadoc и ставит `<p>`
  между абзацами — новые файлы почти гарантированно не проходят. Форматтер без локального JDK:
  `docker run --rm -v "$PWD":/w -w /w -v /root/.m2:/root/.m2 maven:3.9.11-eclipse-temurin-25
  mvn -pl server com.spotify.fmt:fmt-maven-plugin:format`.
- `tsc --noEmit` **не заменяет** `npm run format:check` (prettier) — перенос строки в тесте
  валит всю сборку веба.
- Прогон CI ничего не собирает из `docs/`: правка документации не требует выкатки.
- `COPY --chmod=u=rwX,go=rX <каталог>` в Dockerfile: локальный BuildKit (Docker 29) ставит `x`
  вложенным каталогам, BuildKit раннера CI — нет. С 19.10 по 20.10.2026 шаг «Verify the page player of
  the cinema» падал на `PermissionError: /tests/pages/*.html` у пользователя 10001, хотя локально всё
  проходило. Права каталогов — `RUN chmod -R u=rwX,go=rX …` после `COPY`.
- Строгий ruff кинозала в CI — `--line-length 110 --extend-select E501`; простой `ruff check` его не ловит.

**Ловушка выкладки (17.09.2026).** В репозитории Windows прогон на `main` **выкладывает релиз**
(`desktop.yml`, `desktop-vX.Y.Z`): второй пуш подряд убивал его посреди загрузки установщика, оставался
черновик с одними `.sha256`, а следующий прогон видел «релиз уже есть» и не трогал его. Теперь у
`desktop.yml` `cancel-in-progress` выключен для `main`; застрявший черновик удаляется releases API
(`DELETE`). В репе ядра `cancel-in-progress` на `main` включён — промежуточные коммиты подряд отменяются,
проверяется последний.

Зеркало после релиза **не обновляется само**: `backlog/bin/publish-windows.sh X.Y.Z` качает `desktop-vX.Y.Z`
с GitHub и кладёт в канал `.local/windows-releases/desktop/` (`latest.yml` — последним) и `download.json`.
Пока это не сделано, ни `/download`, ни обновление клиента новой версии не видят. Порядок — `docs/RELEASE.md` §7.

**Медийный сбой раннера (23.09.2026).** Браузерное задание CI поднимает свой стенд с LiveKit на
Windows, и иногда SFU там не встаёт: падают разом все сценарии с «В эфире» (13 штук), хотя код
тот же, что минутой раньше прошёл. Признак — одинаковая ошибка ожидания «В эфире» во всех
медийных спеках. `gh` на машине нет; перезапуск упавших заданий — REST:
`POST /repos/<владелец>/ModernStreamingSystem/actions/runs/<id>/rerun-failed-jobs` с токеном
GitHub из окружения. Логи задания — `GET .../actions/jobs/<job>/logs`.

**Тесты службы в CI ходят в сеть, а локально — нет (25.09.2026).** Локальная команда запускает тесты с
`--network none`, а шаг CI — `docker compose run … services`, у которого `network_mode: host`. Тест, который
незаметно зовёт настоящий адрес (так было с проверкой страны ivi через `create_app`), локально зелёный
потому, что сеть недоступна, и в CI получает ответ сервера GitHub. Проверять не «зелёный ли», а «резолвит ли
хоть одно имя»: `sitecustomize.py` с обёрткой `socket.getaddrinfo`, которая пишет имя в файл, подключить через
`PYTHONPATH=/probe:/app:/tests`. Каталог журнала должен быть доступен на запись uid 10001 (служба не root),
иначе обёртка падает с PermissionError и прогон ничего не доказывает.
