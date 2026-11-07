import { peerRules } from "./turn-guard.mjs";

/**
 * Конфигурация SFU (LiveKit 1.13.6) — одна функция для стенда (`configure.mjs`) и для медиаузлов
 * (`node-config.mjs`), чтобы узел B не разъезжался со стендом ни одним ключом.
 *
 * Чем узел отличается от стенда — только аргументами: `nodeIp`, тройка имён, куда слать вебхуки,
 * есть ли Redis. С R195 узлы — независимые SFU (`docs/architecture/distributed-media.md`, поправка
 * 08.11.2026): у них Redis нет вовсе (`redis` не передаётся), а узел комнаты знает ядро.
 */
export function createLivekit({
  ip,
  turn,
  turnTlsPort,
  externalTls,
  key,
  secret,
  redis,
  metricsPassword,
  maxParticipants,
  webhookUrl,
}) {
  return {
    port: 7880,
    bind_addresses: ["0.0.0.0"],
    rtc: {
      tcp_port: 7881,
      udp_port: 7882,
      use_external_ip: false,
      node_ip: ip,
      // Буфер пакетов звука на SFU — 400 вместо 200 (docs/research §2.8): при RTT 60–120 мс и NACK
      // прежнего не хватало с запасом; видео — 500 по умолчанию.
      packet_buffer_size_audio: 400,
      // Явно, а не по умолчанию: в 1.13.6 `allow_pause` по умолчанию выключен, а решение владельца —
      // пауза видео только у того зрителя, чей канал не тянет, защищает его речь и музыку; отправка у
      // стримящего при этом не деградирует (X10) — DECISIONS.md.
      congestion_control: { enabled: true, allow_pause: true },
      // ICE/TCP пробуется только при обороте до 150 мс, дальше — сразу TURN/TLS (§2.8).
      tcp_fallback_rtt_threshold: 150,
      // Без «принудительного TCP» (27.10.2026). Включённый по умолчанию, он после одного обрыва ICE
      // ставит участнику «только TCP» до конца сессии: UDP вернулся, Wi-Fi подключили — а медиа так и
      // идёт по TCP (на телефоне — 8–10 кадров), и ни ICE restart, ни resume его не возвращают; помогал
      // только перезаход. Опыт A/B на отдельном LiveKit (журнал 2026-10-27): без метки на время потери
      // UDP браузер сам находит TCP, а после возврата UDP новый раунд ICE (`web/src/media/path-retry.ts`)
      // пересаживает медиа обратно. Порог выше действует только вместе с этой меткой; оставлен, чтобы
      // её можно было вернуть одной строкой.
      allow_tcp_fallback: false,
    },
    // RED (RFC 2198) для Opus на отрезке SFU → слушатель. ВНИМАНИЕ: в LiveKit 1.13.6 к дорожке на
    // чистом Opus этот ключ не применяется — SFU записывает кодек дорожки по первому пакету и дальше
    // считает «RED у издателя выключен» (`IsRedEnabled`, `WrappedReceiver.DisableRed`; разбор —
    // services/publisher/red.go). Поэтому избыточность делают сами издатели: браузеры — своим RED
    // (`red: true`, Windows — две копии), издатель музыки — дорожкой `audio/red` с двумя повторами.
    // Ключ оставлен: он безвреден, а в версии, где его починят, включит RED и для чужих издателей.
    // `update_interval`/`smooth_intervals` — 200 мс / 2 вместо 500 / 4: кольцо говорящего в оверлее
    // (§2.5) должно загораться за ≤ 150 мс после голоса, а не через полсекунды.
    audio: { active_red_encoding: true, update_interval: 200, smooth_intervals: 2 },
    ...(redis ? { redis } : {}),
    keys: { [key]: secret },
    room: { empty_timeout: 300, departure_timeout: 60, max_participants: maxParticipants + 4 },
    turn: {
      enabled: true,
      domain: turn,
      udp_port: 3478,
      // TURN/TLS — только в strict: edge снимает TLS с `turn.*` на 443 и отдаёт его сюда, на 5349.
      // LiveKit 1.13 объявляет `turns:<domain>:443` при любом включённом TLS — в simple/ip это был бы
      // мёртвый кандидат на HTTPS-edge (живой `join` стенда, 01.11.2026), поэтому там TLS нет вовсе.
      ...(turnTlsPort ? { tls_port: turnTlsPort, external_tls: externalTls } : {}),
      per_user_relay_allocation_limit: 12,
      // Relay — только к SFU этой машины, не в интернет (A12, `turn-guard.mjs`): иначе учётка TURN любого
      // вошедшего пересылала бы UDP куда угодно с адреса сервера. Проверка живым LiveKit —
      // `scripts/turn-relay-check.sh`.
      ...peerRules(ip),
    },
    webhook: { api_key: key, urls: [webhookUrl] },
    logging: { level: "warn" },
    // Метрики SFU для профиля `monitoring` — только с паролем: LiveKit 1.13 слушает этот порт на тех же
    // `bind_addresses`, что и сигналинг (0.0.0.0), отдельной привязки к 127.0.0.1 у него нет. Без пароля
    // блока нет вовсе, и порт не открывается (docs/observability.md §3).
    ...(metricsPassword ? { prometheus: { port: 6789, username: "metrics", password: metricsPassword } } : {}),
  };
}
