/**
 * Открыт ли сейчас UDP до сервера — без участия звонка.
 *
 * ЗАЧЕМ (27.10.2026). Сторож пути (`path-retry.ts`) возвращает медиа с TCP на UDP перезапуском ICE.
 * Где UDP открылся, это занимает секунды. Но где он всё ещё закрыт, перезапуск вредит: зонд
 * `scripts/path-probe.mjs` при закрытом UDP — без перезапусков TCP разгоняется до 20 кадров за 20 с,
 * с ними три с половиной минуты держится на 1–5. Поэтому на TCP перезапуск идёт только после того,
 * как эта проба увидела ответ сервера по UDP.
 *
 * Проба — отдельное пустое соединение, которое только собирает кандидатов через STUN/TURN комнаты,
 * оставив из них адреса по UDP. Пришёл кандидат srflx или relay — сервер ответил по UDP. Пара
 * пакетов, медиа звонка она не касается, соединение закрывается сразу.
 */

/** Серверы комнаты в той форме, в какой их отдаёт LiveKit (`JoinResponse.iceServers`). */
export interface IceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Только адреса по UDP: `stun:` и `turn:` без `transport=tcp`. `turns:` всегда поверх TLS. */
export function udpServers(servers: readonly IceServerLike[]): RTCIceServer[] {
  return servers.flatMap((server) => {
    const urls = [server.urls]
      .flat()
      .filter((url) => /^(stun|turn):/i.test(url) && !/transport=tcp/i.test(url));
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

/**
 * @returns `true` — сервер ответил по UDP, или проверить не по чему (тогда решает сторож, как
 * раньше: попыток всё равно не больше четырёх).
 */
export async function udpOpen(
  servers: readonly IceServerLike[],
  timeoutMs = 3000,
  create: (config: RTCConfiguration) => RTCPeerConnection = (config) => new RTCPeerConnection(config),
): Promise<boolean> {
  const iceServers = udpServers(servers);
  if (!iceServers.length) return true;
  let pc: RTCPeerConnection | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    pc = create({ iceServers });
    const answered = new Promise<boolean>((resolve) => {
      pc!.onicecandidate = ({ candidate }) => {
        if (!candidate) resolve(false);
        else if (candidate.type === 'srflx' || candidate.type === 'relay') resolve(true);
      };
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    // Без канала данных в предложении нечего собирать.
    pc.createDataChannel('udp-probe');
    await pc.setLocalDescription(await pc.createOffer());
    return await answered;
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
    pc?.close();
  }
}
