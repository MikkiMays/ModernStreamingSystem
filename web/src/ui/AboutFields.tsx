import { useEffect, useState } from 'react';
import { Download, Info, RefreshCw } from 'lucide-react';
import { INSTALLER_URL, RELEASES_PAGE, isNewer, windowsRelease } from '../core/download';
import { desktopVersion, desktopUpdate, notifyDesktop } from '../core/desktop';
import { appLabel, appVersion } from '../core/version';
import { useStore } from './primitives';

/**
 * Что здесь установлено и не вышло ли чего-то нового.
 *
 * Два разных вопроса, которые раньше не задавались вовсе. В браузере обновлять нечего —
 * страница и есть то, что сервер отдал сию секунду, — поэтому проверка отвечает на вопрос
 * про клиент для Windows. В самом приложении обновлять есть что, и проверку выполняет
 * оболочка: страница о её файлах ничего не знает и знать не должна.
 */
export function AboutFields() {
  const desktop = !!window.chrome?.webview;
  const shell = useStore(desktopUpdate);
  const [latest, setLatest] = useState<string | null | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (desktop) notifyDesktop('update.version');
  }, [desktop]);
  const check = () => {
    setChecking(true);
    if (desktop) {
      notifyDesktop('update.check');
      // Ответ придёт сообщением от оболочки; кнопка не должна оставаться нажатой навсегда,
      // если оболочка старая и о такой команде не знает.
      setTimeout(() => setChecking(false), 4000);
      return;
    }
    setLatest(undefined);
    void windowsRelease()
      .then((release) => setLatest(release?.version ?? null))
      .finally(() => setChecking(false));
  };
  useEffect(check, []); // eslint-disable-line react-hooks/exhaustive-deps
  const installed = desktop ? desktopVersion(shell) : appVersion;
  const fresh = latest && installed && isNewer(latest, installed);
  return (
    <section className="audio-settings" aria-label="О программе">
      <h3>
        <Info size={19} /> О программе
      </h3>
      <div className="connection-current">
        <strong>Cord {desktop ? desktopVersion(shell) || '…' : appLabel}</strong>
        <small>{desktop ? 'Приложение для Windows' : 'Веб-клиент этого сервера'}</small>
      </div>
      <div className="check-actions">
        <button className="button secondary" disabled={checking} onClick={check}>
          <RefreshCw size={16} /> {checking ? 'Проверяем…' : 'Проверить обновления'}
        </button>
        {desktop && shell.available && (
          <button className="button primary" onClick={() => notifyDesktop('update.apply')}>
            <Download size={16} /> Обновить
          </button>
        )}
        {!desktop && fresh && (
          <a className="button primary" href={INSTALLER_URL}>
            <Download size={16} /> Скачать {latest}
          </a>
        )}
      </div>
      <p className="form-footnote" role="status">
        {desktop
          ? shell.status || 'Приложение проверяет обновления само, раз в несколько часов.'
          : latest === undefined
            ? 'Смотрим, какой выпуск последний…'
            : latest === null
              ? 'Не удалось узнать последний выпуск. Список всех выпусков открыт по ссылке ниже.'
              : fresh
                ? `Для Windows доступен Cord ${latest}. Веб-клиент обновлять не нужно: страница всегда та, которую отдал сервер.`
                : `Последний выпуск для Windows — ${latest}. Веб-клиент обновляется вместе с сервером.`}
      </p>
      <p className="form-footnote">
        <a className="text-button" href={RELEASES_PAGE}>
          Все выпуски и что в них поменялось
        </a>
      </p>
    </section>
  );
}
