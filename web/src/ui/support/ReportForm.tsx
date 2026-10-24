import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send } from 'lucide-react';
import { prepareHuman, publicApi } from '../../api/client';
import {
  callReportText,
  diagnosticsText,
  ISSUES,
  MAX_CONTACT,
  MAX_MESSAGE,
  problemReport,
  reportProblem,
  type Issue,
} from '../../core/support';
import { useStore } from '../primitives';
import { Button, Field, Input, Switch, Textarea } from '../kit';
import { ToggleChips } from './Chips';
import { callReportSource } from './help';
import { Attachment, Sent, type Receipt } from './parts';

/**
 * «Сообщить о проблеме» (R79): что не так — чипами, подробности по желанию, отчёт о звонке — сам.
 *
 * Как «Сообщить о проблеме» у Discord после звонка: отметить, что было, — быстрее, чем описывать, а
 * владельцу точнее. Во встрече к обращению прикладывается итог этого звонка (`callReport`: путь,
 * оборот, потери, джиттер, замирания — только числа и слова из перечислений) и то же окружение, что у
 * обычного обращения. Переключатель включён: ради отчёта человек сюда и пришёл, а под ним видно ровно
 * то, что уйдёт, — выключить можно одним нажатием. Вне встречи прикладывать нечего, кроме окружения.
 */
export function ReportForm() {
  const { t } = useTranslation();
  const id = useId();
  const source = useStore(callReportSource);
  // Снимок на момент открытия формы, как у обычного обращения.
  const attachment = useMemo(
    () => (source ? `${diagnosticsText()}\n${callReportText(source())}` : diagnosticsText()),
    [source],
  );
  const [issues, setIssues] = useState<Issue[]>([]);
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [consent, setConsent] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  if (receipt)
    return (
      <Sent
        receipt={receipt}
        onAgain={() => {
          setReceipt(null);
          setIssues([]);
          setMessage('');
        }}
      />
    );

  const submit = async () => {
    if (reportProblem(issues, message)) {
      setError(t(($) => $.support.report.noIssues));
      return;
    }
    setSending(true);
    setError('');
    try {
      const body = problemReport(issues, message, contact, consent, attachment);
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
        <span className="ui-field__label" id={`${id}-issues`}>
          {t(($) => $.support.report.what)}
        </span>
        <ToggleChips<Issue>
          labelledBy={`${id}-issues`}
          value={issues}
          onValueChange={(next) => {
            setIssues(next);
            if (error) setError('');
          }}
          options={ISSUES.map((value) => ({ value, label: t(($) => $.support.report.issues[value]) }))}
        />
        {error && (
          <p className="ui-field__error" role="alert">
            {error}
          </p>
        )}
      </div>
      <Field label={t(($) => $.support.report.message)}>
        <Textarea
          rows={3}
          value={message}
          maxLength={MAX_MESSAGE}
          placeholder={t(($) => $.support.report.messagePlaceholder)}
          onChange={(event) => setMessage(event.target.value)}
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
      <Switch
        className="help-consent"
        checked={consent}
        onCheckedChange={setConsent}
        label={source ? t(($) => $.support.report.consent) : t(($) => $.support.form.consent)}
        description={source ? t(($) => $.support.report.consentHint) : t(($) => $.support.form.consentHint)}
      />
      {consent && <Attachment text={attachment} />}
      <Button type="submit" variant="primary" icon={<Send />} loading={sending}>
        {sending ? t(($) => $.support.form.sending) : t(($) => $.support.form.send)}
      </Button>
    </form>
  );
}
