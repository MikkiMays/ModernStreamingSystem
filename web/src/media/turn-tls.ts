import type { IceServerLike } from './udp-probe';

/**
 * TURN по TLS на 443 — последний путь медиа там, где открыт только HTTPS (R149, Р-50, Р-52).
 *
 * ЕСТЬ ЛИ ОН У СЕРВЕРА. LiveKit объявляет его в `JoinResponse.iceServers` адресом `turns:` — и только в
 * режиме `strict` (`scripts/configure.mjs`). Если медиа не встало и при нём, сеть режет даже TLS на
 * 443, и просить владельца не о чем; если его нет — помочь может только владелец сервера. Это и
 * различает надпись «сеть не пропускает звонок» (`session.ts`, `blocked`).
 *
 * ТОЛЬКО ОН — ДЛЯ ДИАГНОСТИКИ. `localStorage['cord:relay'] = 'tls'` в этом браузере: медиа идёт только
 * через ретранслятор (`iceTransportPolicy: 'relay'`) и только по адресам `turns:`. Так проверяют, что
 * путь через 443 на сервере жив и везёт настоящее медиа, не уходя для этого в сеть без UDP
 * (`e2e/turn-tls.spec.ts`). В интерфейсе выключателя нет: это рычаг поддержки, а не настройка.
 *
 * КАК ЭТО ПРОХОДИТ ЧЕРЕЗ SDK (livekit-client 2.22.4, `RTCEngine.makeRTCConfiguration`). `rtcConfig` из
 * `room.connect` копируется разворотом (`{ ...rtcConfig }`) при каждой сборке конфигурации соединения —
 * до входа, после ответа на вход и после resume. Серверные `iceServers` SDK берёт, **только если своих
 * нет** (`!rtcConfig.iceServers`), — не сливает, а заменяет целиком. Задать свои заранее нельзя: учётку
 * TURN сервер выдаёт участнику в ответе на вход. Поэтому `iceServers` здесь — геттер: разворот читает
 * его в момент сборки, а к сборке после входа SDK уже положил ответ в `latestJoinResponse`.
 */

/** Ключ флага в `localStorage`; значение `tls` — только TURN по TLS. */
export const RELAY_KEY = 'cord:relay';

/** Включён ли в этом браузере режим «только TURN по TLS». Хранилище недоступно — нет. */
export function readRelayOnly(storage?: Pick<Storage, 'getItem'>) {
  try {
    // Само обращение к `localStorage` бросает там, где хранилище закрыто (Safari, песочница).
    return (storage ?? localStorage).getItem(RELAY_KEY) === 'tls';
  } catch {
    return false;
  }
}

const tlsUrl = (url: string) => /^turns:/i.test(url);

/** Только адреса `turns:` — с той же учёткой; серверы без них выпадают целиком. */
export function tlsServers(servers: readonly IceServerLike[]): RTCIceServer[] {
  return servers.flatMap((server) => {
    const urls = [server.urls].flat().filter(tlsUrl);
    if (!urls.length) return [];
    return [
      {
        urls,
        ...(server.username ? { username: server.username } : {}),
        ...(server.credential ? { credential: server.credential } : {}),
      },
    ];
  });
}

/** Предлагает ли сервер TURN по TLS. */
export function offersTls(servers: readonly IceServerLike[]) {
  return servers.some((server) => [server.urls].flat().some(tlsUrl));
}

/**
 * `rtcConfig` для `room.connect`: только ретранслятор и только `turns:` из ответа на вход. До ответа
 * серверов нет (пустой список — тоже «свои», и SDK не подставит серверные без фильтра); у сервера без
 * TURN/TLS их не будет и после — тогда медиа не встанет, и это честный ответ проверки.
 */
export function relayOnlyConfig(servers: () => readonly IceServerLike[] | undefined): RTCConfiguration {
  return {
    iceTransportPolicy: 'relay',
    get iceServers() {
      return tlsServers(servers() ?? []);
    },
  };
}
