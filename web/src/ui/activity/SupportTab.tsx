import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send } from 'lucide-react';
import { activityApi, type SupportStatus, type SupportTicket } from '../../core/activity';
import { ISSUES, SUPPORT_TOPICS, type Issue, type SupportTopic } from '../../core/support';
import { Button, Select } from '../kit';
import { Failure, useAdmin, when } from './Activity';

const STATUSES: SupportStatus[] = ['NEW', 'OPEN', 'DONE'];

/**
 * «Обращения» на странице владельца (E13, T36): что пришло из «Помощи», со статусом, который ведёт
 * владелец, и пометкой, донёс ли бот обращение до Telegram. Ответ — по контакту человека, вне Cord.
 */
export function SupportTab({ onExpired }: { onExpired: () => void }) {
  const { t } = useTranslation();
  const { run, error } = useAdmin(onExpired);
  const [tickets, setTickets] = useState<SupportTicket[] | null>(null);
  const [more, setMore] = useState(false);
  const load = useCallback(
    async (before?: number) => {
      const page = await run(() => activityApi.support(before));
      if (!page) return;
      setTickets((current) => (before && current ? [...current, ...page] : page));
      setMore(page.length === 50);
    },
    [run],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const change = async (ticket: SupportTicket, status: SupportStatus) => {
    const done = await run(() => activityApi.supportStatus(ticket.id, status).then(() => true));
    if (done)
      setTickets((current) =>
        (current ?? []).map((item) => (item.id === ticket.id ? { ...item, status } : item)),
      );
  };
  const topic = (value: string) =>
    value === 'report'
      ? t(($) => $.support.report.topic)
      : (SUPPORT_TOPICS as readonly string[]).includes(value)
        ? t(($) => $.support.form.topics[value as SupportTopic])
        : value;
  const issue = (value: string) =>
    (ISSUES as readonly string[]).includes(value) ? t(($) => $.support.report.issues[value as Issue]) : value;
  if (!tickets) return <Failure text={error} />;
  return (
    <section className="activity-section">
      <p className="activity-hint">{t(($) => $.activity.support.hint)}</p>
      <Failure text={error} />
      {tickets.length === 0 ? (
        <p className="activity-empty">{t(($) => $.activity.support.empty)}</p>
      ) : (
        <ul className="activity-tickets">
          {tickets.map((ticket) => (
            <li key={ticket.id} data-status={ticket.status}>
              <div className="activity-tickets__head">
                <strong className="activity-mono">{ticket.number}</strong>
                <span>{topic(ticket.topic)}</span>
                <span className="activity-nowrap">{when(t, ticket.createdAt)}</span>
                <span className="activity-tickets__sent" data-sent={ticket.notifiedAt !== null}>
                  <Send size={16} aria-hidden="true" />
                  {ticket.notifiedAt !== null
                    ? t(($) => $.activity.support.sent)
                    : t(($) => $.activity.support.waiting)}
                </span>
                <Select
                  className="activity-tickets__status"
                  aria-label={t(($) => $.activity.support.status, { number: ticket.number })}
                  value={ticket.status}
                  onChange={(event) => void change(ticket, event.target.value as SupportStatus)}
                >
                  {STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {t(($) => $.activity.support.statuses[status])}
                    </option>
                  ))}
                </Select>
              </div>
              {!!ticket.issues?.length && (
                <p className="activity-tickets__issues">{ticket.issues.map(issue).join(' · ')}</p>
              )}
              {ticket.message && <p className="activity-tickets__message">{ticket.message}</p>}
              <p className="activity-tickets__contact">
                {ticket.contact
                  ? t(($) => $.activity.support.contact, { contact: ticket.contact })
                  : t(($) => $.activity.support.noContact)}
              </p>
              {ticket.diagnostics && (
                <details className="activity-tickets__diagnostics">
                  <summary>{t(($) => $.activity.support.diagnostics)}</summary>
                  <pre>{ticket.diagnostics}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {more && (
        <Button variant="secondary" onClick={() => void load(tickets.at(-1)?.createdAt)}>
          {t(($) => $.activity.support.more)}
        </Button>
      )}
    </section>
  );
}
