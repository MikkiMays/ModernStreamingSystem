import { useState } from 'react';
import { ArrowLeft, Coins, Play, Spade, Timer, TrendingUp, Users, X } from 'lucide-react';
import type { Meeting } from '../core/meeting';
import type { PokerMode } from '../api/types';
import { chips } from '../core/poker';
import { useStore } from './primitives';

/**
 * Игры в панели интеграций: сейчас это покер.
 *
 * Панель здесь — выключатель и выбор правил, а не сама игра: стол живёт на сцене, где его видно
 * целиком, а в узкой колонке он превратился бы в таблицу с номерами мест. Ровно так же устроен
 * кинозал рядом.
 */
const MODES: { id: PokerMode; name: string; hint: string; stack: string; blinds: string; clock: string }[] = [
  {
    id: 'friendly',
    name: 'Дружеская игра',
    hint: 'Блайнды стоят на месте, докупиться можно между раздачами. Никто не вылетает насовсем.',
    stack: '5 000 фишек',
    blinds: '25 / 50, не растут',
    clock: '45 секунд на ход',
  },
  {
    id: 'tournament',
    name: 'Турнир',
    hint: 'Один стек на всю игру, блайнды растут каждые восемь минут. Проиграл — выбыл, и стол считает места.',
    stack: '10 000 фишек',
    blinds: '50 / 100, растут',
    clock: '30 секунд на ход',
  },
  {
    id: 'turbo',
    name: 'Блиц',
    hint: 'Тот же турнир, только быстрее: блайнды каждые три минуты и короткие часы.',
    stack: '3 000 фишек',
    blinds: '50 / 100, каждые 3 мин',
    clock: '15 секунд на ход',
  },
];

export function PokerGroup({ meeting, onBack }: { meeting: Meeting; onBack: () => void }) {
  const snapshot = useStore(meeting.snapshot);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const canUse = !!self && (self.owner || snapshot.integrationsAllowed !== false);
  const table = snapshot.poker;
  const dealer = !!table && (table.hostId === self?.id || !!self?.owner);
  const [mode, setMode] = useState<PokerMode>('friendly');
  const [error, setError] = useState('');
  const send = (type: Parameters<Meeting['command']>[0], extra?: Parameters<Meeting['command']>[3]) => {
    setError('');
    void meeting.command(type, undefined, undefined, extra).catch((e) => setError((e as Error).message));
  };

  return (
    <div className="games-group">
      <button className="text-button cinema-back" onClick={onBack}>
        <ArrowLeft size={16} /> Группы интеграций
      </button>
      {table ? (
        <section className="service-card">
          <div className="service-heading">
            <span className="service-icon" style={{ background: '#8a5cf6' }}>
              <Spade size={24} />
            </span>
            <div>
              <h3>Покер · {table.modeName}</h3>
              <p>
                Раздача №{table.handNumber || 1} · блайнды {chips(table.smallBlind)}/{chips(table.bigBlind)}
              </p>
            </div>
          </div>
          <ul className="games-facts">
            <li>
              <Users size={14} /> За столом {table.seats.filter((seat) => seat.memberId).length} из 10
            </li>
            <li>
              <Coins size={14} /> Стартовый стек {chips(table.startingStack)}
            </li>
            <li>
              <Timer size={14} /> {table.turnSeconds} секунд на ход
            </li>
            {table.levelUpAt > 0 && (
              <li>
                <TrendingUp size={14} /> Уровень {table.level}
              </li>
            )}
          </ul>
          <p className="form-footnote">
            Стол открыт на сцене. Свободное место занимают нажатием на стул, а выйти из-за стола можно в любой
            момент — фишки останутся до конца встречи.
          </p>
          {dealer ? (
            <>
              {table.phase === 'lobby' && (
                <button className="button primary full" onClick={() => send('poker.deal')}>
                  <Play size={17} /> Раздать
                </button>
              )}
              <label className="games-toggle">
                <input
                  type="checkbox"
                  checked={table.seatingOpen}
                  onChange={() =>
                    send('poker.settings', { option: table.seatingOpen ? 'seating-locked' : 'seating-open' })
                  }
                />
                <span>
                  <b>Пускать новых за стол</b>
                  <small>
                    Выключено — сыграть до конца игры не получится никому, кроме тех, кто уже сидит.
                  </small>
                </span>
              </label>
              <label className="games-toggle">
                <input
                  type="checkbox"
                  checked={table.autoDeal}
                  onChange={() => send('poker.settings', { option: 'auto-deal' })}
                />
                <span>
                  <b>Раздавать подряд</b>
                  <small>Выключено — каждую раздачу начинаете вы.</small>
                </span>
              </label>
              <button className="button ghost full" onClick={() => send('poker.close')}>
                <X size={17} /> Убрать стол из встречи
              </button>
            </>
          ) : (
            <p className="form-footnote">Раздаёт тот, кто принёс стол, и ведущий встречи.</p>
          )}
        </section>
      ) : (
        <section className="service-card">
          <div className="service-heading">
            <span className="service-icon" style={{ background: '#8a5cf6' }}>
              <Spade size={24} />
            </span>
            <div>
              <h3>Покер</h3>
              <p>Безлимитный холдем на всю комнату, до десяти игроков</p>
            </div>
          </div>
          <div className="games-modes">
            {MODES.map((item) => (
              <button
                key={item.id}
                className="games-mode"
                data-active={mode === item.id ? 'true' : undefined}
                onClick={() => setMode(item.id)}
              >
                <b>{item.name}</b>
                <small>{item.hint}</small>
                <span>
                  <i>{item.stack}</i>
                  <i>{item.blinds}</i>
                  <i>{item.clock}</i>
                </span>
              </button>
            ))}
          </div>
          {canUse ? (
            <button className="button primary full" onClick={() => send('poker.open', { option: mode })}>
              <Spade size={17} /> Открыть стол
            </button>
          ) : (
            <p className="form-footnote">Добавление интеграций ограничено организатором.</p>
          )}
          <p className="form-footnote">
            Фишки — игровые: ни ставок на деньги, ни счетов здесь нет. Музыка столу не мешает и может играть
            одновременно; кинозал — нет, сцена у них одна.
          </p>
        </section>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
