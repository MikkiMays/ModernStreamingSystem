import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleHelp } from 'lucide-react';
import type { FaqId } from '../../core/support';
import { Dialog, IconButton } from '../kit';
import './help-button.css';

// Окно помощи — отдельным чанком: частые вопросы и форма не нужны, пока «?» не нажали.
const HelpCenter = lazy(() => import('./HelpCenter').then((module) => ({ default: module.HelpCenter })));

/**
 * Значок «Помощь» там, где человек застревает (E13, T36): экран подключения, предпросмотр без
 * доступа к камере, диагностика, ошибка выхода в эфир, «О программе», шапка главной и встречи.
 * Ориентир — «?» в шапке Discord. Открывает помощь окном поверх, а не страницей: во встрече уход на
 * другую страницу закончил бы разговор, а в приложении для Windows открыл бы браузер.
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
  onOpen?: () => void;
  /** Своя подпись кнопки словами («Открыть» в строке «Помощь и поддержка»). */
  text?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = t(($) => $.support.open);
  const show = () => {
    onOpen?.();
    setOpen(true);
  };
  const button =
    look === 'icon' ? (
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
  return (
    <>
      {button}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t(($) => $.support.title)}
        size="lg"
        className="help-dialog"
      >
        {open && (
          <Suspense fallback={<div className="help-loading" aria-busy="true" />}>
            <HelpCenter
              faq={faq}
              onDiagnostics={
                onDiagnostics
                  ? () => {
                      setOpen(false);
                      onDiagnostics();
                    }
                  : undefined
              }
            />
          </Suspense>
        )}
      </Dialog>
    </>
  );
}
