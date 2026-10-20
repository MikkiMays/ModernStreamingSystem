# Lock-файл веба: npm install на хосте рвёт вложенные записи wasm-сборок

`npm install <пакет>` на этой машине (npm 11.6.2, linux-x64) при добавлении зависимости выкинул из
`web/package-lock.json` вложенные `@tailwindcss/oxide-wasm32-wasi/node_modules/@emnapi/core` и `…/runtime`.
Локально всё ставится (wasm32 здесь не нужен), но `npm ci` в образе шлюза проверяет дерево для всех платформ и
падает: «Missing: @emnapi/wasi-threads@1.2.3 from lock file» — выкатка веба и CI красные (20.10.2026).

Как добавлять зависимость: после `npm install` сравнить lock с прежним (`git diff --stat`) — удалённых записей
`node_modules/...` быть не должно. Проверка перед коммитом:

```bash
docker run --rm -v "$PWD/package.json:/w/package.json:ro" -v "$PWD/package-lock.json:/w/package-lock.json:ro" \
  -w /w node:24.11.1-alpine3.22 npm ci --dry-run --ignore-scripts --no-audit --no-fund
```

Починка: взять последний рабочий lock и добавить в `packages` только новые записи (скрипт — коммит
«web: lock-файл снова проходит npm ci», 20.10.2026).
