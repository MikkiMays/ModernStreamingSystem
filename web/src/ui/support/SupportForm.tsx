import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Send } from 'lucide-react';
import { prepareHuman, publicApi } from '../../api/client';
import {
  diagnosticsText,
  MAX_CONTACT,
  MAX_MESSAGE,
  SUPPORT_TOPICS,
  ticket,
  ticketProblem,
  type SupportReceipt,
  type SupportTopic,
} from '../../core/support';
import { Button, Field, Input, Select, Textarea } from '../kit';

/**
 * Форма обращения (E13, T36): тема, что случилось, по желанию — контакт и диагностика.
 *
 * Диагностика уходит только с явной галочкой, и под ней видно ровно то, что уйдёт. Задача «не бот»
 * решается в фоне с первого касания формы — к «Отправить» она обычно уже готова. После отправки —
 * номер обращения и честный ответ, будет ли ответ: без контакта ответить некуда.
 */
export function SupportForm({ topic: initial = 'other' }: { topic?: SupportTopic }) {
  const { t } = useTranslation();
  const id = useId();
  const [topic, setTopic] = useState<SupportTopic>(initial);
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [consent, setConsent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<(SupportReceipt & { contact: boolean }) | null>(null);
  // Снимок окружения — на момент открытия формы; ошибки, случившиеся позже, попадут в следующий.
  const diagnostics = useMemo(() => diagnosticsText(), []);

  if (receipt)
    return (
      <div className="help-sent" role="status">
        <CheckCircle2 size={28} aria-hidden="true" className="help-sent__icon" />
        <p className="help-sent__title">{t(($) => $.support.form.sent, { number: receipt.number })}</p>
        <p className="help-sent__text">
          {receipt.contact ? t(($) => $.support.form.sentContact) : t(($) => $.support.form.sentNoContact)}
        </p>
        <Button
          size="sm"
          onClick={() => {
            setReceipt(null);
            setMessage('');
          }}
        >
          {t(($) => $.support.form.again)}
        </Button>
      </div>
    );

  const submit = async () => {
    const problem = ticketProblem(message);
    if (problem) {
      setError(t(($) => $.support.form.tooShort));
      return;
    }
    setSending(true);
    setError('');
    try {
      const body = ticket(topic, message, contact, consent, diagnostics);
      const answer = await publicApi.support(body);
      setReceipt({ ...answer, contact: !!body.contact });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className="help-form"
      aria-labelledby={`${id}-title`}
      noValidate
      onFocusCapture={() => prepareHuman('support')}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 id={`${id}-title`} className="help-section__title">
        {t(($) => $.support.form.title)}
      </h2>
      <p className="help-section__lead">{t(($) => $.support.form.intro)}</p>
      <Field label={t(($) => $.support.form.topic)}>
        <Select value={topic} onChange={(event) => setTopic(event.target.value as SupportTopic)}>
          {SUPPORT_TOPICS.map((value) => (
            <option key={value} value={value}>
              {t(($) => $.support.form.topics[value])}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t(($) => $.support.form.message)} error={error || undefined}>
        <Textarea
          rows={5}
          value={message}
          maxLength={MAX_MESSAGE}
          required
          placeholder={t(($) => $.support.form.messagePlaceholder)}
          onChange={(event) => {
            setMessage(event.target.value);
            if (error) setError('');
          }}
        />
      </Field>
      <Field label={t(($) => $.support.form.contact)} description={t(($) => $.support.form.contactHint)}>
        <Input
          value={contact}
          maxLength={MAX_CONTACT}
          autoComplete="email"
          placeholder={t(($) => $.support.form.contactPlaceholder)}
          onChange={(event) => setContact(event.target.value)}
        />
      </Field>
      <label className="help-consent">
        <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
        <span>
          <span className="help-consent__label">{t(($) => $.support.form.consent)}</span>
          <span className="help-consent__hint">{t(($) => $.support.form.consentHint)}</span>
        </span>
      </label>
      {consent && (
        <details className="help-preview">
          <summary>{t(($) => $.support.form.preview)}</summary>
          <pre>{diagnostics}</pre>
        </details>
      )}
      <Button type="submit" variant="primary" icon={<Send size={16} />} loading={sending}>
        {sending ? t(($) => $.support.form.sending) : t(($) => $.support.form.send)}
      </Button>
    </form>
  );
}
