import { useEffect, useState } from 'react';
import { Share, SquarePlus, X } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { useMediaQuery } from './primitives';
import { isDesktop } from '../core/desktop';
import { currentPlatform } from '../media/platform';

/**
 * «Вынести Cord на экран „Домой“».
 *
 * Предложение, а не требование: показывается один раз, закрывается насовсем и больше никогда
 * не возвращается. На iOS установку нельзя ни вызвать из кода, ни даже узнать, что она
 * случилась, — поэтому там подсказка объясняет два нажатия, а не изображает кнопку, которой
 * нет. В Chrome браузер сам предлагает установку событием `beforeinstallprompt`, и тогда
 * кнопка настоящая.
 *
 * Не показывается: в оболочке Windows, в уже установленном виде и на устройствах с мышью —
 * там ярлык на рабочем столе решает другую задачу, для которой есть отдельное приложение.
 *
 * На iPhone честно предупреждает (E12): веб-приложение с экрана «Домой» глушит микрофон, как только
 * из него уходят, — свёрнутый разговор там не держится, а в Safari держится (`docs/mobile.md` §2).
 */
const DISMISSED = 'cord:install-hint:dismissed';

type InstallPrompt = Event & { prompt: () => Promise<void> };

export function InstallHint() {
  const { t } = useTranslation();
  const phone = useMediaQuery('(max-width: 700px)');
  const standalone = useMediaQuery('(display-mode: standalone)');
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED) === '1';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    const offer = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    window.addEventListener('beforeinstallprompt', offer);
    return () => window.removeEventListener('beforeinstallprompt', offer);
  }, []);
  const close = () => {
    setHidden(true);
    try {
      localStorage.setItem(DISMISSED, '1');
    } catch {
      /* Приватное окно забудет об этом само. */
    }
  };
  const platform = currentPlatform();
  // `navigator.standalone` — единственный признак установленного веб-приложения на iOS; в приложении
  // Cord для телефона ставить уже нечего.
  const installed = standalone || (navigator as { standalone?: boolean }).standalone === true || platform.app;
  if (hidden || installed || !phone || isDesktop()) return null;
  const iphone = platform.os === 'ios';
  return (
    <aside className="install-hint" role="note">
      <div>
        <strong>{t(($) => $.download.install.title)}</strong>
        {prompt ? (
          <small>{t(($) => $.download.install.app)}</small>
        ) : (
          <small>
            <Trans
              i18nKey={($) => $.download.install.ios}
              components={{
                share: <Share size={13} aria-label={t(($) => $.download.install.share)} />,
                plus: <SquarePlus size={13} aria-hidden="true" />,
              }}
            />
          </small>
        )}
        {iphone && <small>{t(($) => $.download.install.iosBackground)}</small>}
      </div>
      {prompt && (
        <button
          className="button secondary"
          onClick={() => {
            void prompt.prompt().catch(() => {});
            close();
          }}
        >
          {t(($) => $.download.install.install)}
        </button>
      )}
      <button className="icon-button" aria-label={t(($) => $.download.install.hide)} onClick={close}>
        <X size={17} />
      </button>
    </aside>
  );
}
