import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ArrowLeft, Copy, Square } from 'lucide-react';
import { Badge, Button, useToast } from '../../ui/kit';
import { text } from '../../i18n/admin/ru';
import { fleet, type Job, type JobLine } from '../api';
import type { Console } from '../AdminApp';
import { Empty, ErrorLine, Panel, Skeleton, when } from '../parts';

const TONE: Record<Job['status'], 'neutral' | 'accent' | 'success' | 'danger'> = {
  queued: 'neutral',
  running: 'accent',
  ok: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

export function JobStatus({ job }: { job: Job }) {
  return (
    <span className="admin-job-status">
      <Badge variant={TONE[job.status]}>{text.jobs[job.status]}</Badge>
      {job.dryRun && <Badge variant="soon">{text.jobs.dry}</Badge>}
    </span>
  );
}

export function JobRow({ job, onOpen }: { job: Job; onOpen: () => void }) {
  return (
    <tr
      className="admin-table__row"
      onClick={onOpen}
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
    >
      <td className="admin-hint">{when(job.createdAt, true)}</td>
      <td>{job.actor === 'owner' ? text.app.owner : text.app.agent}</td>
      <td>
        <code>{job.kind}</code> <span className="admin-hint">{argsText(job.args)}</span>
      </td>
      <td>{job.machine}</td>
      <td>
        <JobStatus job={job} />
      </td>
    </tr>
  );
}

function argsText(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join(' ');
}

/** Список задач и экран одной задачи (§8.5): живой вывод опросом `after=N` раз в секунду. */
export function Jobs({ console, jobId }: { console: Console; jobId?: string }) {
  if (jobId) return <JobView id={jobId} console={console} />;
  return <JobList console={console} />;
}

function JobList({ console }: { console: Console }) {
  const jobs = useQuery({
    queryKey: ['jobs'],
    queryFn: () => fleet.get<Job[]>('/jobs', { limit: 100 }),
    refetchInterval: 15_000,
  });
  return (
    <Panel title={text.jobs.title}>
      <ErrorLine error={jobs.error} onRetry={() => void jobs.refetch()} />
      {jobs.isPending && <Skeleton />}
      {jobs.data && jobs.data.length === 0 && <Empty>{text.jobs.empty}</Empty>}
      {jobs.data && jobs.data.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>{text.jobs.when}</th>
                <th>{text.jobs.actor}</th>
                <th>{text.jobs.kind}</th>
                <th>{text.jobs.machine}</th>
                <th>{text.jobs.status}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.map((job) => (
                <JobRow key={job.id} job={job} onOpen={() => console.go(`/jobs/${job.id}`)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function JobView({ id, console }: { id: string; console: Console }) {
  const client = useQueryClient();
  const toast = useToast();
  const [lines, setLines] = useState<JobLine[]>([]);
  const [cancelError, setCancelError] = useState<unknown>(null);
  const detail = useQuery({
    queryKey: ['job', id, lines.length ? lines[lines.length - 1]!.n : 0],
    queryFn: async () => {
      const after = lines.length ? lines[lines.length - 1]!.n : 0;
      const result = await fleet.get<{ job: Job; lines: JobLine[] }>(`/jobs/${id}`, { after });
      if (result.lines.length) setLines((prev) => [...prev, ...result.lines]);
      return result.job;
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'running' || status === 'queued' ? 1_000 : false;
    },
  });
  const job = detail.data;
  const cancel = async () => {
    setCancelError(null);
    try {
      await fleet.post(`/jobs/${id}/cancel`);
      void client.invalidateQueries({ queryKey: ['job', id] });
    } catch (failure) {
      setCancelError(failure);
    }
  };
  const repeat = async () => {
    if (!job) return;
    try {
      const next = await fleet.post<Job>('/jobs', {
        kind: job.kind,
        machine: job.machine,
        args: job.args,
        dryRun: job.dryRun,
      });
      void client.invalidateQueries({ queryKey: ['jobs'] });
      console.go(`/jobs/${next.id}`);
    } catch (failure) {
      setCancelError(failure);
    }
  };
  const copy = async () => {
    await navigator.clipboard?.writeText(lines.map((l) => l.text).join('\n'));
    toast.add({ title: text.app.copied });
  };
  return (
    <Panel
      title={
        <>
          <Button
            variant="quiet"
            size="sm"
            icon={<ArrowLeft size={16} />}
            onClick={() => console.go('/jobs')}
          >
            {text.jobs.back}
          </Button>{' '}
          {job ? <code>{job.kind}</code> : id}
        </>
      }
      actions={
        job && (
          <>
            {(job.status === 'running' || job.status === 'queued') && (
              <Button variant="danger" size="sm" icon={<Square size={16} />} onClick={() => void cancel()}>
                {text.jobs.cancel}
              </Button>
            )}
            {job.status !== 'running' && job.status !== 'queued' && (
              <Button variant="secondary" size="sm" onClick={() => void repeat()}>
                {text.jobs.repeat}
              </Button>
            )}
            <Button variant="quiet" size="sm" icon={<Copy size={16} />} onClick={() => void copy()}>
              {text.jobs.copy}
            </Button>
          </>
        )
      }
    >
      <ErrorLine error={detail.error ?? cancelError} onRetry={() => void detail.refetch()} />
      {job && (
        <dl className="admin-dl">
          <dt>{text.jobs.machine}</dt>
          <dd>{job.machine}</dd>
          <dt>{text.jobs.actor}</dt>
          <dd>{job.actor === 'owner' ? text.app.owner : text.app.agent}</dd>
          <dt>{text.jobs.status}</dt>
          <dd>
            <JobStatus job={job} /> {job.summary && <span className="admin-hint">{job.summary}</span>}
          </dd>
          <dt>{text.jobs.started}</dt>
          <dd>{when(job.startedAt, true)}</dd>
          <dt>{text.jobs.finished}</dt>
          <dd>
            {when(job.finishedAt, true)}
            {job.exitCode !== null && (
              <span className="admin-hint">
                {' '}
                · {text.jobs.exit} {job.exitCode}
              </span>
            )}
          </dd>
        </dl>
      )}
      <pre className="admin-log" aria-live="polite">
        {lines.length === 0 ? <span className="admin-hint">{text.jobs.noLines}</span> : null}
        {lines.map((line) => (
          <span key={line.n} className="admin-log__line" data-stream={line.stream}>
            {line.text}
            {'\n'}
          </span>
        ))}
      </pre>
    </Panel>
  );
}
