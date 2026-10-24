import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ChevronDown } from 'lucide-react';
import type { SupportReceipt } from '../../core/support';
import { Button } from '../kit';

/** Номер обращения и оставил ли человек контакт — от этого зависит, обещать ли ответ. */
export type Receipt = SupportReceipt & { contact: boolean };

/**
 * «Что будет отправлено» под переключателем (E13, R38): раскрывает ровно тот текст, что уйдёт. Не
 * `<details>` с системным ▼, а кнопка с `aria-expanded` — как остальные раскрывашки Cord.
 */
export function Attachment({ text }: { text: string }) {
  const { t } = useTranslation();
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <div className="help-preview">
      <button
        type="button"
        className="help-preview__toggle"
        aria-expanded={shown}
        aria-controls={id}
        onClick={() => setShown((value) => !value)}
      >
        {t(($) => $.support.form.preview)}
        <ChevronDown aria-hidden="true" className="help-preview__chevron" />
      </button>
      {shown && (
        <pre id={id} className="help-preview__text">
          {text}
        </pre>
      )}
    </div>
  );
}

/** Обращение ушло: номер и честный ответ про контакт; «Написать ещё» — к пустой форме. */
export function Sent({ receipt, onAgain }: { receipt: Receipt; onAgain: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="help-sent" role="status">
      <CheckCircle2 aria-hidden="true" className="help-sent__icon" />
      <p className="help-sent__title">{t(($) => $.support.form.sent, { number: receipt.number })}</p>
      <p className="help-sent__text">
        {receipt.contact ? t(($) => $.support.form.sentContact) : t(($) => $.support.form.sentNoContact)}
      </p>
      <Button size="sm" onClick={onAgain}>
        {t(($) => $.support.form.again)}
      </Button>
    </div>
  );
}
