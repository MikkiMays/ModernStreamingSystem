import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send } from 'lucide-react';
import { prepareHuman, publicApi } from '../../api/client';
import {
  diagnosticsText,
  MAX_CONTACT,
  MAX_MESSAGE,
  SUPPORT_TOPICS,
  ticket,
  ticketProblem,
  type SupportTopic,
} from '../../core/support';
import { Button, Field, Input, Switch, Textarea } from '../kit';
import { ChoiceChips } from './Chips';
import { Attachment, Sent, type Receipt } from './parts';

/**
 * Форма обращения (E13, T36, R38): тема чипами, что случилось, по желанию — контакт и диагностика.
 *
 * Диагностика уходит только с включённым переключателем, и под ним видно ровно то, что уйдёт. Задача
 * «не бот» решается в фоне с первого касания формы — к «Отправить» она обычно уже готова. После
 * отправки — номер обращения и честный ответ, будет ли ответ: без контакта ответить некуда.
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
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  // Снимок окружения — на момент открытия формы; ошибки, случившиеся позже, попадут в следующий.
  const diagnostics = useMemo(() => diagnosticsText(), []);

  if (receipt)
    return (
      <Sent
        receipt={receipt}
        onAgain={() => {
          setReceipt(null);
          setMessage('');
        }}
      />
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
      noValidate
      onFocusCapture={() => prepareHuman('support')}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="help-field">
        <span className="ui-field__label" id={`${id}-topic`}>
          {t(($) => $.support.form.topic)}
        </span>
        <ChoiceChips<SupportTopic>
          labelledBy={`${id}-topic`}
          value={topic}
          onValueChange={setTopic}
          options={SUPPORT_TOPICS.map((value) => ({ value, label: t(($) => $.support.form.topics[value]) }))}
        />
      </div>
      <Field label={t(($) => $.support.form.message)} error={error || undefined}>
        <Textarea
          rows={4}
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
      {/* Да или нет — переключателем, а не галочкой (X4). */}
      <Switch
        className="help-consent"
        checked={consent}
        onCheckedChange={setConsent}
        label={t(($) => $.support.form.consent)}
        description={t(($) => $.support.form.consentHint)}
      />
      {consent && <Attachment text={diagnostics} />}
      <Button type="submit" variant="primary" icon={<Send />} loading={sending}>
        {sending ? t(($) => $.support.form.sending) : t(($) => $.support.form.send)}
      </Button>
    </form>
  );
}
