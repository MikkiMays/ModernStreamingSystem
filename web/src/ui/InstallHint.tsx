import { useEffect, useState } from 'react';
import { Share, SquarePlus, X } from 'lucide-react';
import { useMediaQuery } from './primitives';

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
 */
const DISMISSED = 'cord:install-hint:dismissed';

type InstallPrompt = Event & { prompt: () => Promise<void> };

export function InstallHint() {
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
  // `navigator.standalone` — единственный признак установленного веб-приложения на iOS.
  const installed = standalone || (navigator as { standalone?: boolean }).standalone === true;
  if (hidden || installed || !phone || !!window.chrome?.webview) return null;
  return (
    <aside className="install-hint" role="note">
      <div>
        <strong>Cord на экране «Домой»</strong>
        {prompt ? (
          <small>Открывается как приложение, без адресной строки.</small>
        ) : (
          <small>
            Нажмите <Share size={13} aria-label="Поделиться" /> и выберите{' '}
            <SquarePlus size={13} aria-hidden="true" /> «На экран „Домой“». Откроется как приложение, без
            адресной строки.
          </small>
        )}
      </div>
      {prompt && (
        <button
          className="button secondary"
          onClick={() => {
            void prompt.prompt().catch(() => {});
            close();
          }}
        >
          Установить
        </button>
      )}
      <button className="icon-button" aria-label="Скрыть подсказку" onClick={close}>
        <X size={17} />
      </button>
    </aside>
  );
}
