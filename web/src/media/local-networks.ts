/**
 * Не появилась ли у устройства другая сеть — для Safari, который об этом не сообщает.
 *
 * ЗАЧЕМ (27.10.2026). iPhone на мобильном интернете, включили Wi-Fi в «Пункте управления» — страница
 * не уходила в фон, `navigator.connection` в Safari нет, и сторож пути (`path-retry.ts`) узнал бы о
 * новой сети только на следующей плановой попытке, через минуты, или никогда. Сам iPhone при этом
 * держит звонок на сотовой сети, пока она жива.
 *
 * Как: пустое соединение без STUN/TURN собирает только свои адреса (кандидаты host) — это перебор
 * своих сетевых интерфейсов, в сеть не уходит ни пакета. Отпечаток — набор адресов; спрятанные за
 * mDNS (`….local`, новое имя на каждое соединение) сравниваются по числу. Спрашивается не чаще раза в
 * 15 с и только пока путь плохой.
 */

export const NETWORK_CHECK_MS = 15_000;
const GATHER_MS = 2000;

type Create = (config: RTCConfiguration) => RTCPeerConnection;
const native: Create = (config) => new RTCPeerConnection(config);

/** Отпечаток своих сетей; `null` — собрать не вышло. */
export async function localNetworks(create: Create = native): Promise<string | null> {
  let pc: RTCPeerConnection | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    pc = create({ iceServers: [] });
    const addresses = new Set<string>();
    const gathered = new Promise<void>((resolve) => {
      pc!.onicecandidate = ({ candidate }) => {
        if (!candidate) return resolve();
        if (candidate.type === 'host' && candidate.address) addresses.add(candidate.address);
      };
      timer = setTimeout(resolve, GATHER_MS);
    });
    pc.createDataChannel('local-networks');
    await pc.setLocalDescription(await pc.createOffer());
    await gathered;
    const named = [...addresses].filter((address) => !address.endsWith('.local')).sort();
    if (named.length) return named.join(' ');
    return addresses.size ? `mdns×${addresses.size}` : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    pc?.close();
  }
}

export class LocalNetworks {
  private last: string | null = null;
  private nextAt = 0;

  constructor(private create: Create = native) {}

  /** @returns `true` — с прошлой проверки появилась или пропала сеть. */
  async changed(now: number): Promise<boolean> {
    if (now < this.nextAt) return false;
    this.nextAt = now + NETWORK_CHECK_MS;
    const current = await localNetworks(this.create);
    if (current === null) return false;
    const previous = this.last;
    this.last = current;
    return previous !== null && previous !== current;
  }

  /** Путь снова хороший: следующая слежка начнёт с нового отпечатка. */
  reset() {
    this.last = null;
    this.nextAt = 0;
  }
}
