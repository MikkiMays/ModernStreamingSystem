import { useTranslation } from 'react-i18next';
import { CircleHelp } from 'lucide-react';
import type { FaqId } from '../../core/support';
import { IconButton } from '../kit';
import { openHelp } from './help';
import './help-button.css';

/**
 * Значок «Помощь» там, где человек застревает (E13, T36): экран подключения, предпросмотр без
 * доступа к камере, ошибка выхода в эфир, «О программе», шапка главной и встречи. Ориентир — «?» в
 * шапке Discord. Открывает помощь окном поверх, а не страницей: во встрече уход на другую страницу
 * закончил бы разговор, а в приложении для Windows открыл бы браузер.
 *
 * Кнопка — только просьба: окно одно на всё приложение и живёт на корне (`HelpHost`, S5, R49).
 * Кнопка внутри другого окна закрывает его в `onOpen` — помощь заменяет окно, а не ложится стопкой.
 *
 * `faq` — с какого вопроса начать (нет доступа к камере — `camera`). `look`: `icon` — значок,
 * `text` — значок с подписью «Помощь», `nav` — строка левой панели главной.
 */
export function HelpButton({
  faq,
  onDiagnostics,
  look = 'icon',
  tone = 'theme',
  className,
  tour,
  onOpen,
  text,
}: {
  faq?: FaqId;
  onDiagnostics?: () => void;
  look?: 'icon' | 'text' | 'nav';
  tone?: 'theme' | 'stage';
  className?: string;
  /** Метка для знакомства (`data-tour`). */
  tour?: string;
  /** Перед открытием: закрыть окно или панель, где стоит кнопка, — помощь их заменяет (S5). */
  onOpen?: () => void;
  /** Своя подпись кнопки словами («Открыть» в строке «Помощь и поддержка»). */
  text?: string;
}) {
  const { t } = useTranslation();
  const label = t(($) => $.support.open);
  const show = () => {
    onOpen?.();
    openHelp({ faq, onDiagnostics });
  };
  return look === 'icon' ? (
    <IconButton label={label} tone={tone} className={className} onClick={show} data-tour={tour}>
      <CircleHelp size={18} />
    </IconButton>
  ) : (
    <button
      type="button"
      className={className ?? (look === 'nav' ? 'home-nav__link' : 'help-link')}
      onClick={show}
      data-tour={tour}
    >
      <CircleHelp size={look === 'nav' ? 18 : 16} aria-hidden="true" />
      {text ?? label}
    </button>
  );
}
