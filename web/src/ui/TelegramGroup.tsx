import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, Link2, Send, UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { MusicApi, type TelegramLinkCode } from '../core/services';
import { Button } from './kit';
import { shelfName } from './integration-shelf';

/**
 * Telegram во встрече (E09, T04, T30): привязать встречу к беседе и видеть, какие беседы её открывают.
 *
 * Сюда попадает только тот, кому ядро разрешает `telegram.link`, — создатель встречи; витрина
 * остальным эту группу не открывает. Привязка — одноразовый код на 15 минут: кнопкой «Добавить бота в
 * группу» (Telegram сам предложит группу, добавит бота с правом закрепа и пришлёт код) или командой в
 * чате. После привязки бот закрепляет в беседе кнопку «Открыть встречу» — Mini App на весь экран.
 */
export function TelegramGroup({ meeting, onBack }: { meeting: Meeting; onBack: () => void }) {
  const { t } = useTranslation();
  const api = useMemo(() => new MusicApi(meeting.admission), [meeting]);
  const client = useQueryClient();
  const key = ['telegram-chats', meeting.admission.roomId, meeting.admission.participantId];
  const [code, setCode] = useState<TelegramLinkCode | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  // Сколько бесед было, когда выдали код: стало больше — код использован, и он больше не нужен.
  const before = useRef(0);
  const chats = useQuery({
    queryKey: key,
    queryFn: api.telegramChats,
    // Пока код на экране, привязка случится в Telegram — список спрашивается чаще.
    refetchInterval: code ? 3000 : 15000,
  });
  const links = chats.data?.links ?? [];
  useEffect(() => {
    if (code && links.length > before.current) setCode(null);
  }, [code, links.length]);

  const issue = async () => {
    setError('');
    try {
      before.current = links.length;
      setCode(await api.linkTelegram());
      setCopied(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const unlink = async (id: string) => {
    setError('');
    try {
      client.setQueryData(key, await api.unlinkTelegram(id));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="platform-picker telegram-group">
      <Button
        variant="quiet"
        size="sm"
        className="platform-picker__back"
        icon={<ArrowLeft />}
        onClick={onBack}
      >
        {t(($) => $.integrations.telegram.back)}
      </Button>
      <div className="platform-picker__head">
        <h3 className="platform-picker__title">{shelfName(t, 'telegram')}</h3>
        <p className="platform-picker__lead">{t(($) => $.integrations.telegram.lead)}</p>
      </div>
      {links.length > 0 && (
        <section className="telegram-group__chats" aria-labelledby="telegram-chats-title">
          <h4 id="telegram-chats-title">{t(($) => $.integrations.telegram.chats)}</h4>
          <ul>
            {links.map((link) => (
              <li key={link.id} className="telegram-group__chat">
                <span className="telegram-group__chat-icon" aria-hidden="true">
                  <Send size={16} />
                </span>
                <span className="telegram-group__chat-text">
                  <b>{link.chatTitle}</b>
                  <small>
                    {link.pinned
                      ? t(($) => $.integrations.telegram.pinned)
                      : t(($) => $.integrations.telegram.notPinned)}
                  </small>
                </span>
                <Button
                  variant="quiet"
                  size="sm"
                  aria-label={t(($) => $.integrations.telegram.unlinkNamed, { title: link.chatTitle })}
                  onClick={() => void unlink(link.id)}
                >
                  {t(($) => $.integrations.telegram.unlink)}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {code ? (
        <section className="telegram-group__code" aria-live="polite">
          <a
            className="ui-button ui-button--primary ui-button--lg ui-button--full"
            href={code.startgroupUrl}
            target="_blank"
            rel="noreferrer"
          >
            <UserPlus aria-hidden="true" />
            {t(($) => $.integrations.telegram.addBot)}
          </a>
          <p>{t(($) => $.integrations.telegram.orCommand)}</p>
          <div className="telegram-group__command">
            <code>{code.command}</code>
            <Button variant="secondary" size="sm" icon={<Copy />} onClick={() => void copy()}>
              {copied ? t(($) => $.integrations.telegram.copied) : t(($) => $.integrations.telegram.copy)}
            </Button>
          </div>
          <small>{t(($) => $.integrations.telegram.expires)}</small>
        </section>
      ) : (
        <Button variant="primary" size="lg" full icon={<Link2 />} onClick={() => void issue()}>
          {t(($) => $.integrations.telegram.link)}
        </Button>
      )}
      {error && (
        <p className="services-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
