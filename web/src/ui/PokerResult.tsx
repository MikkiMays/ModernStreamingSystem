import { Coins, Crown, Layers, Timer, TrendingUp, Trophy } from 'lucide-react';
import type { PokerEnding, PokerGame, PokerPlayer } from '../api/types';
import { chips, plural, winnerOf } from '../core/poker';

/**
 * Итоги игры: то, с чем люди встали из-за стола.
 *
 * ОДИН ВИД НА ДВА МЕСТА, И ЭТО НАМЕРЕННО. Эту же таблицу показывает сцена в конце игры и панель
 * «Игры» — в истории беседы. Две копии разошлись бы через месяц, и «сколько он поставил» считалось
 * бы в них по-разному; палитру задаёт тот, кто её вставляет, поэтому на тёмном столе она тёмная, а
 * в панели — обычная.
 *
 * ЗДЕСЬ НИЧЕГО НЕ СЧИТАЕТСЯ. Все числа приехали с сервера посчитанными по ходу игры — к её концу
 * ни карт, ни ставок, ни половины сидевших уже нет, и восстановить «сколько раз он пошёл ва-банк»
 * браузеру было бы неоткуда.
 */
/* Подписи ко всем концам игры. Тип здесь не `string`, а закрытый набор: забытый конец не
   компилируется, и «Игра окончена» вместо объяснения больше не появится. */
const ENDINGS: Record<PokerEnding, string> = {
  winner: 'За столом остался один',
  closed: 'Стол убрали из встречи',
  idle: 'За столом никого не осталось',
  meeting: 'Встреча закончилась',
};

/** Сколько игра шла — словами, а не двумя метками времени. */
function span(from: number, to: number): string {
  const minutes = Math.max(1, Math.round((to - from) / 60000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
}

export function GameResult({ game }: { game: PokerGame }) {
  const winner = winnerOf(game);
  return (
    <div className="poker-result">
      <ul className="poker-result-facts">
        <li>
          <Layers size={13} /> {plural(game.hands, 'раздача', 'раздачи', 'раздач')}
        </li>
        <li>
          <Coins size={13} /> банк до {chips(game.biggestPot)}
        </li>
        <li>
          <TrendingUp size={13} /> блайнды {chips(game.smallBlind)}/{chips(game.bigBlind)}
        </li>
        <li>
          <Timer size={13} /> {span(game.startedAt, game.finishedAt)}
        </li>
      </ul>
      <p className="poker-result-ending">
        {game.modeName} · {ENDINGS[game.ending] ?? 'Игра окончена'}
      </p>
      {game.highlights.length > 0 && (
        <ul className="poker-result-highlights">
          {game.highlights.map((one) => (
            <li key={one.id}>
              <b>{one.title}</b>
              <span>{one.name}</span>
              <u>{one.value}</u>
              <small>{one.hint}</small>
            </li>
          ))}
        </ul>
      )}
      <ol className="poker-result-players">
        {game.players.map((player, index) => (
          <li key={`${player.name}-${index}`} data-top={player === winner || undefined}>
            <i className="poker-result-place" aria-hidden="true">
              {player.place > 0 ? player.place : index + 1}
            </i>
            <b>
              {player.name}
              {player.place === 1 && <Crown size={13} />}
            </b>
            <span className="poker-result-stack">
              {chips(player.stack)}
              <u data-up={player.net >= 0 || undefined}>
                {player.net >= 0 ? '+' : '−'}
                {chips(Math.abs(player.net))}
              </u>
            </span>
            <small>{story(player)}</small>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Что человек делал за столом — одной строкой.
 *
 * Таблица из пятнадцати столбцов в панели шириной триста восемьдесят пикселей не читается вовсе,
 * поэтому числа стоят фразой и только те, в которых что-то было: «докупок 0» и «ва-банк 0» — это
 * не статистика, а заполненная графа.
 */
function story(player: PokerPlayer): string {
  const parts = [`поставил ${chips(player.invested)}`];
  if (player.hands > 0) parts.push(`выиграл ${player.handsWon} из ${player.hands}`);
  if (player.allIns > 0) parts.push(`ва-банк ${player.allIns}`);
  if (player.rebuys > 0) parts.push(`докупок ${player.rebuys}`);
  if (player.knockouts > 0) parts.push(`выбил ${player.knockouts}`);
  if (player.showdowns > 0) parts.push(`вскрытий ${player.showdownWins}/${player.showdowns}`);
  if (player.bestHand) parts.push(player.bestHand);
  return parts.join(' · ');
}

/** Заголовок итогов: чем игра кончилась и кто в ней первый. */
export function GameCrown({ game }: { game: PokerGame }) {
  const winner = winnerOf(game);
  return (
    <span className="poker-result-crown">
      <Trophy size={18} />
      <b>{winner ? winner.name : 'Игра окончена'}</b>
      <small>{winner ? `${chips(winner.stack)} на конец игры` : ''}</small>
    </span>
  );
}
