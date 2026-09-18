import { useState } from 'react';
import { Copy, Send } from 'lucide-react';

/** Привязка комнаты к беседе. К музыке относится только тем, что оттуда тоже шлют треки. */
export function TelegramService({
  username,
  canLink,
  busy,
  link,
  onLink,
  onError,
}: {
  username: string | null | undefined;
  canLink: boolean;
  busy: boolean;
  link: { command: string; expiresAt: number } | null;
  onLink: () => void;
  onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="service-card telegram-card">
      <div className="service-heading">
        <span className="service-icon telegram">
          <Send size={22} />
        </span>
        <div>
          <h3>Telegram</h3>
          <p>Встреча и музыка из вашей беседы</p>
        </div>
      </div>
      {username ? (
        <>
          <a
            href={`https://t.me/${username}?startgroup=true`}
            target="_blank"
            rel="noopener noreferrer"
            className="button secondary full"
          >
            Добавить @{username} в чат
          </a>
          <p className="form-footnote">
            Ответьте на аудиофайл командой /play@{username}. /meet откроет встречу. Привязку можно менять
            отдельно для каждого чата и темы.
          </p>
          {canLink && (
            <button
              className="button secondary full"
              disabled={busy}
              onClick={() => {
                setCopied(false);
                onLink();
              }}
            >
              Связать эту комнату с чатом
            </button>
          )}
          {link && (
            <div className="telegram-link">
              <p>
                Отправьте эту команду в нужный чат или тему от имени администратора. Код действует 15 минут.
              </p>
              <code>{link.command}</code>
              <button
                className="button secondary full"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(link.command)
                    .then(() => setCopied(true))
                    .catch(() => onError('Выделите и скопируйте команду вручную'));
                }}
              >
                <Copy size={16} />
                {copied ? 'Скопировано' : 'Скопировать команду'}
              </button>
              <p className="form-footnote">
                Участники привязанного чата смогут открывать эту комнату и управлять общей музыкой.
              </p>
            </div>
          )}
        </>
      ) : (
        <p className="muted">
          Подключение Telegram настраивается на сервере. Загрузка файлов в музыку доступна отдельно.
        </p>
      )}
    </section>
  );
}
