# Карта клиента Windows и развёртывания — E00, 19.10.2026

## Клиент Windows (`ModernStreamingSystem.Windows`, main 0d5c2fa, 0.7.5)

- `Cord.slnx`: `src/Cord.Core` (net10.0, TreatWarningsAsErrors), `src/Cord.Windows` (WinUI x64),
  `tests/Cord.Core.Tests` (xUnit v3). Версия — **только** `Cord.Windows.csproj:19 <Version>`. SDK 10.0.400.
- Шапка `MainWindow.xaml:8-14`: `PaneToggle` 40×36, `DragRegion`, **текстовый логотип
  `TextBlock Text="cord"` (13)** и точка-акцент 5 px (14). SplitView 244 px. Компактный режим —
  MenuFlyout (`MainWindow.xaml.cs:935-952`).
- WebView2 (`Services/WebWorkspace.cs`): DevTools выключены, навигация за пределы сервера закрыта,
  камера/микрофон через диалог WinUI. **`ContextMenuRequested` не обрабатывается** — меню Edge по ПКМ (T42).
- Мост v1 (`Cord.Core/BridgeProtocol.cs`): страница→клиент `state, favorites.changed, close-ready,
  hotkey.configure, preferences.changed, call-state, servers.open, session.expired, server.autoconnect,
  update.version, update.check, update.apply`; клиент→страница `navigate, theme.changed,
  preferences.changed, hotkey.status, microphone.toggle, session.token, settings.open, network.changed,
  close-request, update.status, favorite.settings, favorites.changed`. Bootstrap пишет в localStorage
  `cord:profile:v1, cord:theme, cord:preferences:v1, cord:servers:v1`.
- Серверы: `ServerList.cs` (Max 20, ручное добавление `:42-60`), выбор `MainWindow.xaml.cs:343-721`
  («Добавить сервер» 399-413, ручной ввод 660-721), опрос `capabilities` каждые 5 с.
- Профиль: `ProfileStore.cs` — `%LOCALAPPDATA%\Cord\settings.json`, DPAPI на секрет избранного и пароль.
- Клавиша микрофона: `GlobalMicrophoneHotkey.cs` (`RegisterHotKey`, только во время звонка; keyup нет).
- Обновление: `ReleaseClient.cs:14` — **сначала анонимный GitHub API** (приватная репа → 404),
  зеркало `https://meet.nikg.tech/downloads/windows/latest.json` зашито (`CordDefaults.cs:25-26`);
  ссылка на установщик обязана быть GitHub-URL (`:34`). `ApplicationUpdater.cs` + `Update.ps1` (ASCII).
- Установщик `installer/Cord.iss`: `AppPublisherURL/AppSupportURL/AppUpdatesURL` на GitHub (46-48),
  языки russian+english (60-62), **`desktopicon` с `Flags: unchecked` (64-65)**; `About-installation.txt`
  — «впишите адрес сервера» и ссылка на исходники.
- CI `windows.yml`: windows-2022 → bootstrap, `dotnet format whitespace`, build, `verify-service.ps1`
  (**по умолчанию против `https://meet.nikg.tech/`** — CI зависит от старого прода), installer, тест
  установщика, артефакт ~420 МБ **на 14 дней** (главный пожиратель квоты артефактов аккаунта). Релиз —
  на пуше в main, `gh release create v$version`.

## Развёртывание (`ModernStreamingSystem`)

- `setup.sh`: `--domain NAME` (simple) | `--ip-only` (ip) | `--app/--rtc/--turn` (strict), `--ip`,
  `--ssh-port`, `--skip-firewall`. Шаги: configure (если нет `.env`), `scripts/firewall.sh` (ufw:
  22, 80 кроме ip, 443, 7881/tcp, 7882/udp, 3478/udp, 5349 кроме strict; deny 7880/8080/8090/8091/5432/6379),
  `infra/tidy.sh --install`, стена sniffer (`validate`, `--install`, `check`), build, up, ожидание health,
  `turn-cert.sh` (simple).
- `update.sh`: пересобирает по изменённым каталогам, откат `cord-rollback-*` при ошибке.
- `compose.yaml`: edge (caddyl4), gateway (веб+Caddy), core, services (127.0.0.1:18100), sniffer
  (своя подсеть 10.231.0.0/24, 127.0.0.1:18103), postgres 18.3, redis 8.6.6, livekit 1.13.6, tusd 2.10.0.
  **Профилей compose нет.**
- `configure.mjs` пишет `.env` (DEPLOY_MODE, APP/RTC/TURN_HOST, PUBLIC_IP, PUBLIC_URL, LIVEKIT_*, секреты,
  DATABASE_*, REDIS_*, ACCESS_PASSWORD пуст = сервер открыт) и `infra/generated/` (tls, livekit.json с
  `max_participants 10`, edge.json, topology.json, redis.conf). `--refresh` — только производные файлы.
- Старый прод (`docs/deployment-meet-nikg-tech.md`): strict, `--legacy-hosts`, **sysctl буферов
  сокетов 7 500 000** (`/etc/sysctl.d/90-cord-media.conf`) — `setup.sh` этого не делает.
- Смена режима: новый `.env` = новый `DATABASE_PASSWORD`, а том базы помнит старый — переносить пароль.
- `web/.local/stack.sh` (стенд со своим SFU) **в репе нет** — `.local/` в `.gitignore`.

## CI ядра — диагноз 18.10.2026

- core: тесты зелёные (290), падает `upload-artifact` — квота хранилища артефактов аккаунта.
- browser (windows-2022): `ECONNREFUSED 127.0.0.1:18100` — шум (службы в браузерном задании не
  поднимаются, спеки это терпят). Настоящее: 37 медийных сценариев не дождались «В эфире» — SFU стенда
  на раннере не встал (известная грабля `cord-ci-and-release-traps`); журналов нет, потому что артефакт
  не загрузился. Исправлено в E00: `continue-on-error` у загрузок, печать `.local/logs` при падении.
