/**
 * Кого и насколько громко слушать в этой встрече.
 *
 * ЗАЧЕМ. Громкость — решение слушателя, и принимается оно один раз: «Петю тише», «музыку на
 * пять процентов». Держалась она в памяти вкладки и ключом ей был номер участника — а номер
 * этот выдаётся на каждый вход заново. Петя переподключился — и снова гремит; музыку убрали
 * из встречи и вернули — и она снова в полную силу, хотя её для того и убавляли, чтобы
 * разговор было слышно. Выставлять одно и то же по десять раз за вечер человек не должен.
 *
 * КЛЮЧ — НЕ НОМЕР УЧАСТНИКА. Вернувшийся получает новое место в комнате, и по номеру его не
 * узнать. Узнаётся он именем; служебный участник — своим видом (`service:music`), потому что
 * имя у бота может и смениться, а «музыка в этой встрече» — это одна и та же музыка.
 * Полных тёзок это путает, и это осознанная цена: перепутанная громкость поправляется
 * ползунком, а забытая — раздражает весь вечер.
 *
 * ГДЕ ЖИВЁТ. В `localStorage`, по встречам: обещание звучит как «в этой встрече», и в
 * соседнюю оно не переезжает. Переживает и перезагрузку страницы — она ничем не отличается
 * от переподключения. Помнится столько встреч, сколько их видел этот браузер, но не больше
 * {@link ROOMS}: список этот вспомогательный, и расти без конца ему незачем.
 */
const key = 'cord:volumes:v1';
/** Сколько встреч помнить. Дальше — самые старые уходят. */
const ROOMS = 20;

type Remembered = Record<string, Record<string, number>>;

function read(): Remembered {
  try {
    const data = JSON.parse(localStorage.getItem(key) ?? '{}');
    return data && typeof data === 'object' ? (data as Remembered) : {};
  } catch {
    return {};
  }
}

/** Устойчивое имя участника в памяти громкостей — или `null`, если узнать его не по чему. */
export function volumeKey(person: { name?: string | null; service?: string | null }): string | null {
  if (person.service) return `service:${person.service}`;
  const name = (person.name ?? '').trim().toLowerCase();
  return name ? `name:${name}` : null;
}

export function recallVolume(roomId: string, person: string): number | undefined {
  const value = read()[roomId]?.[person];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function rememberVolume(roomId: string, person: string, volume: number) {
  const all = read();
  const room = { ...(all[roomId] ?? {}), [person]: volume };
  // Порядок ключей — это и есть порядок обращения: переписанная встреча уходит в конец, и
  // вычёркиваются с головы те, к которым не возвращались дольше всех.
  const { [roomId]: _, ...rest } = all;
  const entries = [...Object.entries(rest), [roomId, room] as const].slice(-ROOMS);
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* Переполненное хранилище не повод ронять встречу: громкость просто не переживёт вкладку. */
  }
}
