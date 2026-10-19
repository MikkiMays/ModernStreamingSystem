import type { Participant } from '../api/types';
import type { Cue } from './sounds';

const PRESENT: Participant['status'][] = ['JOINING', 'CONNECTED', 'RECOVERING'];
/**
 * Сколько после «ушёл» возвращение того же человека считается тем же разговором, а не новостью.
 *
 * Связь, порванная дольше окна восстановления (20 с), ядро закрывает участие; клиент сразу входит
 * снова под новым номером. Так выглядел хост, замиравший на 20–55 с (T38): комната слышала «вышел» и
 * через пару секунд «вошёл», хотя никто ничего не нажимал. Минуты хватает на возврат после сбоя и не
 * съедает настоящий уход и приход.
 */
const RETURN_GRACE_MS = 60_000;
/** Сколько последних причин звука помнит журнал клиента. */
const JOURNAL_SIZE = 50;

type Reason = 'arrived' | 'left' | 'knocked';
export interface CueRecord {
  at: number;
  cue: Cue;
  participantId: string;
  reason: Reason;
}

const present = (status?: Participant['status']) => !!status && PRESENT.includes(status);

/**
 * Из двух снимков комнаты — то, что стоит услышать: кто-то пришёл, ушёл, просится войти.
 *
 * Слышно только людей. Бот музыки — служебный участник, а не собеседник. Смена статуса
 * восстановления — то же участие. Переподключение под новым номером (в том же снимке или вскоре
 * после ухода) — возвращение, а не уход и приход. Свой вход и выход озвучивается там, где они
 * происходят, а не отсюда.
 */
export class RoomCues {
  private roster = new Map<string, Participant>();
  /** Кто недавно ушёл: имя → когда. По нему узнаётся возвращение под новым номером. */
  private departed = new Map<string, number>();
  readonly journal: CueRecord[] = [];

  constructor(private readonly self: string) {}

  /** Начальный состав — без звуков: в комнату входите вы, а не все остальные. */
  seed(participants: Participant[]) {
    this.roster = new Map(participants.map((p) => [p.id, p]));
  }

  next(participants: Participant[], now = Date.now()): Cue[] {
    const previous = this.roster;
    this.roster = new Map(participants.map((p) => [p.id, p]));
    for (const [name, at] of this.departed) if (now - at > RETURN_GRACE_MS) this.departed.delete(name);

    const people = (list: Iterable<Participant>) =>
      [...list].filter((p) => p.id !== this.self && p.service == null);
    const arrivals = people(participants).filter(
      (p) => present(p.status) && !present(previous.get(p.id)?.status),
    );
    const departures = people(previous.values()).filter(
      (p) => present(p.status) && !present(this.roster.get(p.id)?.status),
    );
    const cues: Cue[] = [];
    const arrivedNames = new Set(arrivals.map((p) => p.name));
    for (const person of departures) {
      // Ушёл и тут же вошёл под тем же именем — это переподключение одного человека.
      if (arrivedNames.has(person.name)) {
        arrivedNames.delete(person.name);
        continue;
      }
      this.departed.set(person.name, now);
      cues.push(this.record('leave', person.id, 'left', now));
    }
    for (const person of people(participants)) {
      const before = previous.get(person.id)?.status;
      if (person.status === 'WAITING' && before !== 'WAITING')
        cues.push(this.record('knock', person.id, 'knocked', now));
    }
    for (const person of arrivals) {
      if (!arrivedNames.has(person.name)) continue;
      if (this.departed.has(person.name)) {
        this.departed.delete(person.name);
        continue;
      }
      cues.push(this.record('join', person.id, 'arrived', now));
    }
    return cues;
  }

  private record(cue: Cue, participantId: string, reason: Reason, at: number): Cue {
    this.journal.push({ at, cue, participantId, reason });
    if (this.journal.length > JOURNAL_SIZE) this.journal.shift();
    return cue;
  }
}
