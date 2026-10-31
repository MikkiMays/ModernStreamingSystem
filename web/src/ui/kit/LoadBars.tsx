import { useTranslation } from 'react-i18next';

/** Состояние сервера из `GET /api/v1/load` (Р-37); `unknown` — ответа нет. */
export type LoadState = 'ok' | 'busy' | 'full' | 'maintenance' | 'closed' | 'unknown';

export interface LoadBarsProps {
  /** Ступень 1–4; 0 или нет — неизвестно. */
  level?: number;
  state?: LoadState;
  /** Подпись словами рядом с палочками («низкая», «мест нет»). Без неё — только палочки. */
  withText?: boolean;
  className?: string;
}

/**
 * Загрузка сервера — четыре палочки одной высоты (R143, Р-37).
 *
 * Одной высоты нарочно: «лесенку» читают как силу сигнала, где больше — лучше, а рядом с пингом её
 * прочли бы наоборот. Одинаковые столбики с заливкой читаются как шкала «больше — теснее». Цвет —
 * токены: 1–2 — success, 3 — warning, 4 — danger; пустые — приглушённые. Число не показывается:
 * наружу сервер отдаёт только ступень. Для диктора — словами, в `aria-label` и `title`.
 */
export function LoadBars({ level = 0, state = 'unknown', withText = false, className }: LoadBarsProps) {
  const { t } = useTranslation();
  const known = level >= 1 && level <= 4 && state !== 'unknown' && state !== 'maintenance';
  const filled = known ? level : 0;
  const tone = filled >= 4 ? 'danger' : filled === 3 ? 'warning' : 'success';
  const words =
    state === 'full'
      ? t(($) => $.kit.load.full)
      : state === 'maintenance'
        ? t(($) => $.kit.load.maintenance)
        : state === 'closed'
          ? t(($) => $.kit.load.closed)
          : known
            ? t(($) => $.kit.load.levels[filled as 1 | 2 | 3 | 4])
            : t(($) => $.kit.load.unknown);
  const label = t(($) => $.kit.load.label, { value: words });
  return (
    <span
      className={['ui-load', className].filter(Boolean).join(' ')}
      role="img"
      aria-label={label}
      title={label}
      data-tone={known ? tone : undefined}
    >
      <span className="ui-load__bars" aria-hidden="true">
        {[1, 2, 3, 4].map((bar) => (
          <span key={bar} className="ui-load__bar" data-on={bar <= filled || undefined} />
        ))}
      </span>
      {withText && (
        <span className="ui-load__text" aria-hidden="true">
          {words}
        </span>
      )}
    </span>
  );
}
