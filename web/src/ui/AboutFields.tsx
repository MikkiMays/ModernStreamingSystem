import { useEffect, useState } from 'react';
import { Download, Github, Info, RefreshCw, Send, TriangleAlert } from 'lucide-react';
import { INSTALLER_URL, RELEASES_PAGE, isNewer, windowsRelease } from '../core/download';
import { CORE_REPOSITORY_URL, commitsLabel, upstreamState } from '../core/upstream-version';
import { desktopUpdate, desktopVersion, notifyDesktop } from '../core/desktop';
import { appLabel, appVersion } from '../core/version';
import { useStore } from './primitives';

/**
 * Внешняя ссылка, которая работает и в приложении.
 *
 * Оболочка Windows отменяет любой переход на чужой адрес внутри окна и отдаёт системному
 * браузеру только то, что просит новое окно, — то есть `target="_blank"`. Без него ссылка
 * внутри приложения просто ничего не делает, и это не догадка: ровно так себя вела «Все
 * выпуски», пока её не убрали отсюда.
 */
function External({
  href,
  label,
  children,
}: {
  href: string;
  /** Чем ссылка называется, когда на ней виден только значок. */
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      className="text-button"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
    >
      {children}
    </a>
  );
}

/**
 * Что здесь установлено и не вышло ли чего-то нового.
 *
 * Два разных вопроса. В браузере обновлять нечего — страница и есть то, что сервер отдал сию
 * секунду, — поэтому проверка отвечает про клиент для Windows. В самом приложении обновлять
 * есть что, и проверку выполняет оболочка: страница о её файлах ничего не знает.
 *
 * Плашки появляются, только когда есть что сказать. «Всё актуально» человек видит по их
 * отсутствию, и говорить это отдельной строкой значит занимать место ничем.
 */
export function AboutFields() {
  const desktop = !!window.chrome?.webview;
  const shell = useStore(desktopUpdate);
  const [latest, setLatest] = useState<string | null | undefined>(undefined);
  const [behind, setBehind] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (desktop) notifyDesktop('update.version');
    void upstreamState().then((state) => setBehind(state?.behind ?? null));
  }, [desktop]);
  const check = () => {
    setChecking(true);
    if (desktop) {
      notifyDesktop('update.check');
      // Ответ придёт сообщением от оболочки; кнопка не должна остаться нажатой навсегда,
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
  const fresh = !!latest && !!installed && isNewer(latest, installed);
  return (
    <section className="audio-settings" aria-label="О программе">
      <h3>
        <Info size={19} /> О программе
      </h3>
      <div className="connection-current">
        <strong>Cord {desktop ? desktopVersion(shell) || '…' : appLabel}</strong>
        <small>{desktop ? 'Приложение для Windows' : 'Веб-клиент этого сервера'}</small>
      </div>

      {desktop && shell.available && (
        <p className="update-notice" role="status">
          <TriangleAlert size={15} />
          <span>{shell.status || 'Доступно обновление приложения.'}</span>
        </p>
      )}
      {!desktop && fresh && (
        <p className="update-notice" role="status">
          <TriangleAlert size={15} />
          <span>Для Windows вышел Cord {latest}.</span>
        </p>
      )}
      {behind !== null && (
        <p className="update-notice" role="status">
          <TriangleAlert size={15} />
          <span>
            Сервер отстаёт на {commitsLabel(behind)}. Обновить — <code>./update.sh</code> в каталоге проекта
            на сервере.
          </span>
        </p>
      )}

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
      {!desktop && (
        <p className="form-footnote" role="status">
          {latest === undefined
            ? 'Смотрим, какой выпуск последний…'
            : latest === null
              ? 'Не удалось узнать последний выпуск для Windows.'
              : fresh
                ? 'Веб-клиент обновлять не нужно: страница всегда та, которую отдал сервер.'
                : `Последний выпуск для Windows — ${latest}. Веб-клиент обновляется вместе с сервером.`}
        </p>
      )}
      {desktop && shell.status && !shell.available && (
        <p className="form-footnote" role="status">
          {shell.status}
        </p>
      )}

      <div className="about-author">
        <p>
          Cord создаёт и развивает <strong>@nikgers</strong>.
        </p>
        {/*
          У двух ссылок остались одни значки: конверт Telegram и кот GitHub узнаются и без
          подписи, а подписи рядом с именем автора читались как призыв написать. Имя для
          доступности и подсказки никуда не делось — оно в `aria-label`.
        */}
        <div className="check-actions">
          <External href="https://t.me/nikgers" label="Telegram автора">
            <Send size={16} />
          </External>
          <External href={CORE_REPOSITORY_URL} label="Исходный код">
            <Github size={16} />
          </External>
          {/* В приложении эта ссылка лишняя: обновления оно ставит само, а список выпусков —
              разговор для того, кто читает репозиторий, и до него один клик выше. */}
          {!desktop && <External href={RELEASES_PAGE}>Все выпуски</External>}
        </div>
      </div>
    </section>
  );
}
