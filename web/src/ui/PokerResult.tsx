import { Coins, Crown, Layers, Timer, TrendingUp, Trophy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PokerGame, PokerPlayer } from '../api/types';
import { chips, winnerOf } from '../core/poker';
import type { Translate } from '../i18n';

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
/* Подписи ко всем концам игры — в каталоге (`poker.result.endings`), ключ — сам конец. Набор
   закрытый: конец без подписи в каталоге не компилируется, и «Игра окончена» вместо объяснения
   остаётся только для концов, которых этот браузер ещё не знает. */
function ending(t: Translate, game: PokerGame): string {
  return t(($) => $.poker.result.endings[game.ending], { defaultValue: t(($) => $.poker.gameOver) });
}

/** Сколько игра шла — словами, а не двумя метками времени. */
function span(t: Translate, from: number, to: number): string {
  const minutes = Math.max(1, Math.round((to - from) / 60000));
  if (minutes < 60) return t(($) => $.poker.result.minutes, { minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest
    ? t(($) => $.poker.result.hoursMinutes, { hours, minutes: rest })
    : t(($) => $.poker.result.hours, { hours });
}

export function GameResult({ game }: { game: PokerGame }) {
  const { t } = useTranslation();
  const winner = winnerOf(game);
  return (
    <div className="poker-result">
      <ul className="poker-result-facts">
        <li>
          <Layers size={13} /> {t(($) => $.poker.result.hands, { count: game.hands })}
        </li>
        <li>
          <Coins size={13} /> {t(($) => $.poker.result.biggestPot, { amount: chips(t, game.biggestPot) })}
        </li>
        <li>
          <TrendingUp size={13} />{' '}
          {t(($) => $.poker.result.blinds, {
            small: chips(t, game.smallBlind),
            big: chips(t, game.bigBlind),
          })}
        </li>
        <li>
          <Timer size={13} /> {span(t, game.startedAt, game.finishedAt)}
        </li>
      </ul>
      <p className="poker-result-ending">
        {game.modeName} · {ending(t, game)}
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
              {chips(t, player.stack)}
              <u data-up={player.net >= 0 || undefined}>
                {player.net >= 0 ? '+' : '−'}
                {chips(t, Math.abs(player.net))}
              </u>
            </span>
            <small>{story(t, player)}</small>
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
function story(t: Translate, player: PokerPlayer): string {
  const parts = [t(($) => $.poker.result.invested, { amount: chips(t, player.invested) })];
  if (player.hands > 0)
    parts.push(t(($) => $.poker.result.won, { won: player.handsWon, hands: player.hands }));
  if (player.allIns > 0) parts.push(t(($) => $.poker.result.allIns, { allIns: player.allIns }));
  if (player.rebuys > 0) parts.push(t(($) => $.poker.result.rebuys, { rebuys: player.rebuys }));
  if (player.knockouts > 0) parts.push(t(($) => $.poker.result.knockouts, { knockouts: player.knockouts }));
  if (player.showdowns > 0)
    parts.push(t(($) => $.poker.result.showdowns, { won: player.showdownWins, total: player.showdowns }));
  if (player.bestHand) parts.push(player.bestHand);
  return parts.join(' · ');
}

/** Заголовок итогов: чем игра кончилась и кто в ней первый. */
export function GameCrown({ game }: { game: PokerGame }) {
  const { t } = useTranslation();
  const winner = winnerOf(game);
  return (
    <span className="poker-result-crown">
      <Trophy size={18} />
      <b>{winner ? winner.name : t(($) => $.poker.gameOver)}</b>
      <small>{winner ? t(($) => $.poker.result.finalStack, { amount: chips(t, winner.stack) }) : ''}</small>
    </span>
  );
}
