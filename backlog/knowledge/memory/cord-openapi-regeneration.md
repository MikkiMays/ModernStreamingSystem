---
name: cord-openapi-regeneration
description: "Как перегенерировать contracts/openapi.json в Cord, когда прод-ядро отдаёт 404 на /api/openapi"
metadata: 
  type: reference
---

`npm run generate:api` в [[meet-cord-system]] ходит на локальное ядро (`/api/openapi`), а прод-ядро
там отвечает **404**: в `compose.yaml` стоит `SPRINGDOC_API_DOCS_ENABLED: 'false'`. Поднимать
второе ядро рядом с продом тоже нельзя вслепую — оно попросит базу.

Рабочий обход: запустить уже собранный образ отдельным контейнером с H2 в памяти и включённым
springdoc, на своём свободном порту.

```
docker run --rm -d --name cord-openapi -p <локальный адрес>:<порт>:<порт> \
  -e SPRING_PROFILES_ACTIVE=local -e SERVER_PORT=<порт> -e SPRINGDOC_API_DOCS_ENABLED=true \
  -e DATABASE_PASSWORD=x -e FILES_ROOT=/tmp/uploads \
  -e SPRING_DATASOURCE_URL='jdbc:h2:mem:contracts;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1' \
  modern-streaming-core
API_SCHEMA_URL=<адрес ядра>/api/openapi npm run generate:api   # из web/
```

Профиль `local` сам по себе не годится: он пишет H2 в `./.local`, а внутри образа это
`/app/.local` без прав — контейнер падает на Flyway. Отсюда явный `SPRING_DATASOURCE_URL`.

**Список типов команд в схеме — не из `@Pattern`.** Его руками перечисляет `OpenApiConfig`.
Добавил тип команды в `Contracts.Command` — добавь и туда, иначе фронт получит старый union и
`tsc` не пропустит новый вызов. Там же делается `nullable` для полей, которые ядро отдаёт `null`.
