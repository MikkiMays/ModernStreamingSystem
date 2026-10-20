import { useState, type MouseEvent } from 'react';
import { Button, Dialog } from '../kit';
import './notices.css';

/*
  Ссылки в чате (E11-B, A6 модели угроз): фишинг ссылкой — главный способ обмануть в переписке.
  Ссылка показывает свой настоящий домен — для доменов на национальных алфавитах ещё и в форме
  `xn--`, по которой подмену букв видно, — а переход спрашивает «Ссылка ведёт на …. Открыть?».
  Внешних проверок (Safe Browsing и подобных) нет: переписка встречи никуда не уходит.

  Тексты — здесь, одним местом: слой переводов E14 заберёт их в `locales/ru.json`.
*/
const TEXT = {
  title: 'Переход по ссылке',
  leadsTo: 'Ссылка ведёт на',
  question: 'Открыть?',
  open: 'Открыть',
  cancel: 'Отмена',
};

const LINK = /https?:\/\/[^\s<>"'«»]+[^\s<>"'«».,;:!?)\]]/giu;

/** Части текста: обычный текст и ссылки с их настоящим доменом. */
export function splitLinks(text: string): ({ text: string } | { url: string; host: string })[] {
  const parts: ({ text: string } | { url: string; host: string })[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    let host: string;
    try {
      host = new URL(match[0]).hostname;
    } catch {
      continue;
    }
    const at = match.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ url: match[0], host });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** Домен так, как его написали, — если он отличается от настоящего (IDN), рядом форма `xn--`. */
function written(url: string): string {
  return url.replace(/^https?:\/\//i, '').split(/[/?#:]/)[0] ?? '';
}

/** Текст сообщения, где ссылки показывают домен и переходят только после подтверждения. */
export function ChatText({ text }: { text: string }) {
  const [pending, setPending] = useState<{ url: string; host: string } | null>(null);
  const parts = splitLinks(text);
  if (!parts.some((part) => 'url' in part)) return <>{text}</>;
  const ask = (part: { url: string; host: string }) => (event: MouseEvent) => {
    event.preventDefault();
    setPending(part);
  };
  return (
    <>
      {parts.map((part, index) =>
        'url' in part ? (
          <a
            key={index}
            className="chat-link"
            href={part.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={ask(part)}
          >
            {part.url}
            {written(part.url).toLowerCase() !== part.host && (
              <span className="chat-link__host"> ({part.host})</span>
            )}
          </a>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={TEXT.title}
        size="sm"
        description={
          <>
            {TEXT.leadsTo} <strong>{pending?.host}</strong>. {TEXT.question}
          </>
        }
        footer={
          <>
            <Button variant="quiet" onClick={() => setPending(null)}>
              {TEXT.cancel}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (pending) window.open(pending.url, '_blank', 'noopener,noreferrer');
                setPending(null);
              }}
            >
              {TEXT.open}
            </Button>
          </>
        }
      />
    </>
  );
}
