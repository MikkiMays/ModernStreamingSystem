import { isValidElement, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Logo } from '../brand/Logo';
import { CardsScene, CordScene, type Deck } from './scenes';
import './loader.css';

/**
 * Полноэкранная загрузка (T55, П14): весь экран, фон из токенов, живая сцена в центре, марка
 * под ней. Ни полосы прогресса, ни слова «загрузка». Показывается, пока грузится настоящее:
 * `ready` — экран пропускает клики и гаснет за 200 мс (120, если сцена ещё не проявилась),
 * затем размонтируется. Если готово раньше `showAfterMs`, сцены не было — был только фон.
 *
 * Сцены: `cord` — пульс марки (старт приложения), `cards` — карты с рубашкой Cord (покер,
 * дурак; `sceneProps.deck`), или свой узел — только `transform`/`opacity` внутри.
 * `tone="dark"` — всегда тёмный фон (вход в игру), `theme` — фон темы человека (старт).
 */
export type LoaderScene = 'cord' | 'cards' | ReactElement;

export interface FullscreenLoaderProps {
  ready: boolean;
  /** Для диктора; на экране не виден: «Открываем Cord», «Раздаём карты». */
  label: string;
  scene?: LoaderScene;
  sceneProps?: { deck?: Deck };
  tone?: 'theme' | 'dark';
  showAfterMs?: number;
  reducedMotion?: 'static' | 'breathe';
  /** Через сколько показать тихую строку «Сеть медленная» и «Повторить». */
  slowAfterMs?: number;
  onRetry?: () => void;
  onExited?: () => void;
  brand?: boolean;
  /** Для витрины: в потоке страницы, а не поверх всего. */
  inline?: boolean;
}

export function FullscreenLoader({
  ready,
  label,
  scene = 'cord',
  sceneProps,
  tone = 'theme',
  showAfterMs = 150,
  reducedMotion = 'static',
  slowAfterMs = 12000,
  onRetry,
  onExited,
  brand = true,
  inline = false,
}: FullscreenLoaderProps) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const [exited, setExited] = useState(false);
  const [slow, setSlow] = useState(false);
  const exit = useRef(onExited);
  exit.current = onExited;

  useEffect(() => {
    if (ready || inline) return;
    const timer = setTimeout(() => setSlow(true), slowAfterMs);
    return () => clearTimeout(timer);
  }, [ready, inline, slowAfterMs]);

  useEffect(() => {
    if (!ready || exited) return;
    const el = root.current;
    if (!el) return;
    let cancelled = false;
    el.style.pointerEvents = 'none';
    const fade = el.querySelector<HTMLElement>('.fl__fade');
    const shown = fade ? getComputedStyle(fade).opacity !== '0' : true;
    const finish = () => {
      if (cancelled) return;
      setExited(true);
      exit.current?.();
    };
    if (typeof el.animate !== 'function') {
      finish();
      return;
    }
    const animation = el.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: shown ? 200 : 120,
      easing: 'ease-in',
      fill: 'forwards',
    });
    animation.finished.then(finish, finish);
    return () => {
      cancelled = true;
      animation.cancel();
    };
  }, [ready, exited]);

  if (exited) return null;
  const body = isValidElement(scene) ? (
    scene
  ) : scene === 'cards' ? (
    <CardsScene deck={sceneProps?.deck} />
  ) : (
    <CordScene />
  );
  return (
    <div
      ref={root}
      className={inline ? 'fl fl--inline' : 'fl'}
      role="status"
      data-tone={tone}
      data-reduced={reducedMotion}
      data-ready={ready || undefined}
      style={{ '--fl-delay': `${showAfterMs}ms` } as CSSProperties}
    >
      <span className="fl__status">{label}</span>
      <div className="fl__fade" aria-hidden="true">
        <div className="fl__stage">{body}</div>
        {brand && <Logo className="fl__brand" />}
      </div>
      {slow && (
        <div className="fl__slow">
          <span>{t(($) => $.loader.slow)}</span>
          {onRetry && (
            <button type="button" className="ui-button ui-button--quiet ui-button--sm" onClick={onRetry}>
              {t(($) => $.loader.retry)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
