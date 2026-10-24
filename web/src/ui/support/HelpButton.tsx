import { useTranslation } from 'react-i18next';
import { Headset } from 'lucide-react';
import type { FaqId } from '../../core/support';
import { IconButton } from '../kit';
import { openHelp } from './help';
import './help-button.css';

/**
 * «Поддержка» там, где человек застревает (E13, T36): экран подключения, предпросмотр без доступа к
 * камере, ошибка выхода в эфир, шапка главной и встречи. Значок — гарнитура, как принято у поддержки
 * (R37), а не «?». Открывает поддержку окном поверх, а не страницей: во встрече уход на другую
 * страницу закончил бы разговор, а в приложении для Windows открыл бы браузер.
 *
 * Кнопка — только просьба: окно одно на всё приложение и живёт на корне (`HelpHost`, S5, R49).
 * Кнопка внутри другого окна закрывает его в `onOpen` — помощь заменяет окно, а не ложится стопкой.
 *
 * `faq` — с какого вопроса начать (нет доступа к камере — `camera`). `look`: `icon` — значок,
 * `text` — значок с подписью «Поддержка», `nav` — строка левой панели главной.
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
  /** Своя подпись кнопки словами вместо «Поддержка». */
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
      <Headset />
    </IconButton>
  ) : (
    <button
      type="button"
      className={className ?? (look === 'nav' ? 'home-nav__link' : 'help-link')}
      onClick={show}
      data-tour={tour}
    >
      <Headset size={look === 'nav' ? 18 : 16} aria-hidden="true" />
      {text ?? label}
    </button>
  );
}
