import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Copy,
  Download,
  File,
  FileUp,
  MicOff,
  Paperclip,
  Pause,
  Play,
  Send,
  UserPlus,
  UserX,
  X,
} from 'lucide-react';
import type { Participant } from '../api/types';
import type { Meeting } from '../core/meeting';
import { Avatar, useStore } from './primitives';
import { Button, IconButton, Tab, TabList, TabPanel, Tabs } from './kit';
import { Track } from 'livekit-client';
import { Services } from './Services';
import { ParticipantMenu } from './ParticipantMenu';
import { allowed } from '../core/permissions';
import { serverInfo } from '../core/session';
import { humans } from '../core/people';
import {
  composerHeight,
  DEFAULT_FILE_MAX_BYTES,
  formatBytes,
  MAX_PENDING,
  oversize,
  pastedImage,
} from './chat';
import { ChatAttachments, type PendingFile } from './ChatAttachments';
import { useVoiceTier } from './useVoice';
import { ExecutableNote } from './abuse/Notices';
import { ChatText } from './abuse/ChatText';
import { locale } from '../i18n';

export type Panel = 'people' | 'chat' | 'services';
export function Sidebar({
  meeting,
  panel,
  setPanel,
  onClose,
  onInvite,
}: {
  meeting: Meeting;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  onClose: () => void;
  onInvite: () => void;
}) {
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const revision = useStore(meeting.fileRevision);
  const ended = useStore(meeting.ended);
  const uploading = useStore(meeting.uploader.state);
  const tracks = useStore(meeting.media.tracks);
  const [now, setNow] = useState(Date.now);
  // Недописанное хранит встреча, а не панель: закрытая панель его не уносит (`Meeting.draft`).
  const draft = useStore(meeting.draft);
  const setDraft = (text: string) => meeting.draft.set(text);
  const [error, setError] = useState('');
  /** Почему выбранный файл не ушёл — у поля и в момент выбора (T02), а не подписью заранее. */
  const [refusal, setRefusal] = useState('');
  const [sending, setSending] = useState(false);
  /** Вложения над полем: уйдут вместе с текстом по Enter (R94). */
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [feedback, setFeedback] = useState('');
  const [search, setSearch] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryClient = useQueryClient();
  const files = useQuery({
    queryKey: ['files', snapshot.id, meeting.admission.participantId],
    queryFn: meeting.api.files,
    refetchInterval: panel === 'chat' ? 5000 : false,
  });
  useEffect(() => {
    const next = Math.min(
      ...[...snapshot.messages.map((m) => m.expiresAt), ...(files.data ?? []).map((f) => f.expiresAt)].filter(
        (expiry) => expiry > now,
      ),
    );
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(
      () => {
        setNow(Date.now());
        void meeting.refresh();
      },
      Math.max(1000, next - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [snapshot.messages, files.data, meeting, now]);
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ['files', snapshot.id] });
  }, [revision, queryClient, snapshot.id]);
  useEffect(() => {
    if (nearBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [snapshot.messages, files.data, panel]);
  // Люди без ботов — одно правило на весь веб (`core/people.ts`), как и у мест в ядре.
  const people = humans(snapshot.participants);
  // Сколько людей вмещает встреча — говорит сервер (`capabilities.maxParticipants`, T06): боты, как
  // и в списке выше, не в счёт. Ответ тот же, что на главной, и обычно уже лежит в кэше.
  const capabilities = useQuery({
    queryKey: ['capabilities'],
    queryFn: serverInfo,
    staleTime: Infinity,
  }).data;
  const seats = capabilities?.maxParticipants;
  // Предел файла — тоже от сервера (`stream.file-max-bytes`); пока ответа нет — прежние 100 МиБ.
  const fileMaxBytes = capabilities?.fileMaxBytes ?? DEFAULT_FILE_MAX_BYTES;
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const writable = !ended && self && self.status !== 'WAITING';
  const timeline = [
    ...snapshot.messages
      .filter((m) => m.expiresAt > Date.now())
      .map((message) => ({
        kind: 'message' as const,
        id: message.id,
        at: message.createdAt,
        message,
      })),
    ...(files.data ?? [])
      .filter((f) => f.completedAt && f.expiresAt > Date.now())
      .map((file) => ({
        kind: 'file' as const,
        id: file.id,
        at: file.completedAt!,
        file,
      })),
  ].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const run = async (type: Parameters<Meeting['command']>[0], targetId?: string) => {
    try {
      await meeting.command(type, undefined, targetId);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  /*
    Вложение — скрепка, перетаскивание или Ctrl+V скриншота (R94) — сначала ложится превью над полем,
    как у GPT и Claude, и уходит вместе с текстом по Enter. Слишком большой файл не ложится: отказ
    словами сразу, в момент выбора (T02).
  */
  const attach = (files: Iterable<globalThis.File> | ArrayLike<globalThis.File> | null | undefined) => {
    if (!files || !writable) return;
    const accepted: PendingFile[] = [];
    let problem = '';
    for (const file of Array.from(files)) {
      const refused = oversize(t, file, fileMaxBytes);
      if (refused) problem = refused;
      else accepted.push({ id: crypto.randomUUID(), file });
    }
    setRefusal(problem);
    if (accepted.length) setPending((current) => [...current, ...accepted].slice(0, MAX_PENDING));
  };
  /*
    Отправка: сначала вложения по одному (загрузчик везёт один файл за раз), затем текст — подпись
    встаёт в ленте после картинки. Не дошёл файл — текст остаётся в поле, а файлы, до которых очередь
    не дошла, — над ним; у недошедшего — «Повторить» в полосе загрузки.
  */
  const send = async () => {
    const text = draft;
    if ((!text.trim() && !pending.length) || sending || !writable) return;
    setSending(true);
    setError('');
    const files = pending;
    setPending([]);
    try {
      for (const [index, item] of files.entries()) {
        nearBottom.current = true;
        if (await meeting.uploader.send(item.file)) continue;
        setPending((current) => [...files.slice(index + 1), ...current]);
        return;
      }
      if (text.trim()) {
        await meeting.command('message.send', text);
        // Пока грузилось, могли дописать — стирается только отправленное.
        if (meeting.draft.get() === text) setDraft('');
        nearBottom.current = true;
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  /*
    Поле растёт по строкам до шести, а скрепка и «Отправить» стоят на линии его последней строки
    (T02). Высоту считает `composerHeight` по настоящей высоте текста: CSS `field-sizing` умеет пока
    не каждый браузер.
  */
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    const style = getComputedStyle(field);
    const line = parseFloat(style.lineHeight) || 20;
    const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    field.style.height = 'auto';
    const { height, scrolls } = composerHeight(field.scrollHeight, line, padding);
    field.style.height = `${height}px`;
    field.style.overflowY = scrolls ? 'auto' : 'hidden';
  }, [draft, panel]);
  useEffect(
    () => () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    },
    [],
  );
  const copyMessage = async (text: string) => {
    setError('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error(t(($) => $.sidebar.noClipboard));
      await navigator.clipboard.writeText(text);
      setFeedback(t(($) => $.sidebar.copied));
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
      feedbackTimer.current = setTimeout(() => setFeedback(''), 2200);
    } catch (e) {
      setFeedback('');
      setError((e as Error).message || t(($) => $.sidebar.copyFailed));
    }
  };
  const time = (at: number) => (
    <time dateTime={new Date(at).toISOString()}>
      {new Date(at).toLocaleTimeString(locale(t), { hour: '2-digit', minute: '2-digit' })}
    </time>
  );
  return (
    <aside className="side-panel" aria-label={t(($) => $.sidebar.panel)}>
      <div className="panel-heading">
        <h2>{t(($) => $.sidebar.titles[panel])}</h2>
        <IconButton label={t(($) => $.sidebar.close)} onClick={onClose}>
          <X size={20} />
        </IconButton>
      </div>
      <Tabs value={panel} onValueChange={(v) => setPanel(v as Panel)} className="panel-tabs-root">
        <TabList className="panel-tabs" aria-label={t(($) => $.sidebar.sections)}>
          <Tab value="people">
            {t(($) => $.sidebar.people)} <span className="panel-tabs__count">{people.length}</span>
          </Tab>
          <Tab value="chat">{t(($) => $.sidebar.chat)}</Tab>
          <Tab value="services">{t(($) => $.sidebar.services)}</Tab>
        </TabList>
        <TabPanel value="people" className="panel-body people-panel">
          <Button variant="secondary" full icon={<UserPlus />} onClick={onInvite}>
            {t(($) => $.sidebar.invite)}
          </Button>
          <input
            type="search"
            className="people-search"
            aria-label={t(($) => $.sidebar.search)}
            placeholder={t(($) => $.sidebar.search)}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="panel-section-label">
            {seats
              ? t(($) => $.sidebar.hereOf, { count: people.length, seats })
              : t(($) => $.sidebar.here, { count: people.length })}
          </div>
          <div className="participant-list">
            {people
              .filter((p) => p.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
              .map((p) => (
                <ParticipantMenu className="participant-row" key={p.id} meeting={meeting} person={p}>
                  <VoiceAvatar meeting={meeting} person={p} />
                  <div className="participant-info">
                    <strong>
                      {p.name}
                      {p.id === self?.id ? t(($) => $.sidebar.you) : ''}
                    </strong>
                    <small>
                      {p.status === 'WAITING'
                        ? t(($) => $.sidebar.waiting)
                        : p.status === 'JOINING'
                          ? t(($) => $.sidebar.joining)
                          : p.status === 'RECOVERING'
                            ? t(($) => $.sidebar.recovering)
                            : p.owner
                              ? t(($) => $.sidebar.owner)
                              : t(($) => $.sidebar.member)}
                    </small>
                  </div>
                  {allowed(snapshot, meeting.admission.participantId, 'participant.remove') && !p.owner ? (
                    <>
                      {p.status === 'WAITING' &&
                        allowed(snapshot, meeting.admission.participantId, 'participant.approve') && (
                          <IconButton
                            size="sm"
                            label={t(($) => $.sidebar.approve, { name: p.name })}
                            onClick={() => void run('participant.approve', p.id)}
                          >
                            <Check size={18} />
                          </IconButton>
                        )}
                      <IconButton
                        size="sm"
                        label={t(($) => $.sidebar.remove, { name: p.name })}
                        onClick={() => void run('participant.remove', p.id)}
                      >
                        <UserX size={17} />
                      </IconButton>
                    </>
                  ) : (
                    !tracks.some(
                      (t) => t.participantId === p.id && t.source === Track.Source.Microphone && !t.muted,
                    ) && (
                      <MicOff
                        className="participant-muted"
                        size={16}
                        aria-label={t(($) => $.sidebar.micOff)}
                      />
                    )
                  )}
                </ParticipantMenu>
              ))}
          </div>
        </TabPanel>
        <TabPanel
          value="chat"
          className="chat-panel"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            attach(e.dataTransfer.files);
          }}
        >
          <div className="retention-note">{t(($) => $.sidebar.retention)}</div>
          <input
            type="file"
            ref={fileInput}
            hidden
            multiple
            aria-label={t(($) => $.sidebar.attach)}
            onChange={(e) => {
              attach(e.target.files);
              e.target.value = '';
            }}
          />
          <div
            className="messages"
            ref={scroll}
            onScroll={(e) => {
              const el = e.currentTarget;
              nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            aria-label={t(($) => $.sidebar.log)}
            role="log"
            aria-live="polite"
          >
            {!timeline.length && (
              <div className="chat-empty">
                <span className="chat-empty-icon">
                  <Paperclip size={22} />
                </span>
                <strong>{t(($) => $.sidebar.emptyTitle)}</strong>
                <p>{t(($) => $.sidebar.emptyText)}</p>
              </div>
            )}
            {timeline.map((entry) =>
              entry.kind === 'message' ? (
                <div
                  className={'message' + (entry.message.participantId === self?.id ? ' own' : '')}
                  key={entry.id}
                >
                  <div className="message-meta">
                    <strong>{entry.message.name}</strong>
                    {time(entry.at)}
                  </div>
                  <div className="message-body">
                    <p>
                      <ChatText text={entry.message.text} />
                    </p>
                    <IconButton
                      size="sm"
                      label={t(($) => $.sidebar.copy)}
                      className="message-copy"
                      onClick={() => void copyMessage(entry.message.text)}
                    >
                      <Copy size={15} />
                    </IconButton>
                  </div>
                </div>
              ) : (
                <div
                  className={'message attachment-message' + (entry.file.ownerId === self?.id ? ' own' : '')}
                  key={entry.id}
                >
                  <div className="message-meta">
                    <strong>
                      {snapshot.participants.find((p) => p.id === entry.file.ownerId)?.name ??
                        t(($) => $.sidebar.someone)}
                    </strong>
                    {time(entry.at)}
                  </div>
                  <div className="file-row">
                    <span className="file-icon">
                      <File size={20} />
                    </span>
                    <div>
                      <strong title={entry.file.name}>{entry.file.name}</strong>
                      <small>
                        {formatBytes(t, entry.file.size)} · {t(($) => $.sidebar.temporary)}
                      </small>
                      <ExecutableNote file={entry.file} />
                    </div>
                    <IconButton
                      label={t(($) => $.sidebar.download, { name: entry.file.name })}
                      onClick={() =>
                        void meeting.api.download(entry.file).catch((e) => setError((e as Error).message))
                      }
                    >
                      <Download size={18} />
                    </IconButton>
                  </div>
                </div>
              ),
            )}
            {files.data
              ?.filter((f) => !f.completedAt && f.expiresAt > Date.now() && f.name !== uploading.name)
              .map((file) => (
                <div className="file-row" key={file.id}>
                  <span className="file-icon">
                    <FileUp size={20} />
                  </span>
                  <div>
                    <strong>{file.name}</strong>
                    <small>{t(($) => $.sidebar.unfinished)}</small>
                  </div>
                  <IconButton
                    label={t(($) => $.sidebar.dropUnfinished, { name: file.name })}
                    onClick={() =>
                      void meeting.api
                        .cancel(file.id)
                        .then(() => queryClient.invalidateQueries({ queryKey: ['files', snapshot.id] }))
                        .catch((e) => setError((e as Error).message))
                    }
                  >
                    <X size={18} />
                  </IconButton>
                </div>
              ))}
            {files.isError && <p className="form-error">{t(($) => $.sidebar.filesFailed)}</p>}
          </div>
          {uploading.status !== 'idle' && (
            <div className="upload-progress">
              <strong>{uploading.name}</strong>
              <progress value={uploading.progress} max={1} aria-label={t(($) => $.sidebar.progress)} />
              <div>
                <span>
                  {uploading.status === 'paused'
                    ? t(($) => $.sidebar.paused)
                    : uploading.status === 'done'
                      ? t(($) => $.sidebar.done)
                      : uploading.status === 'error'
                        ? t(($) => $.sidebar.failed)
                        : Math.round(uploading.progress * 100) + '%'}
                </span>
                {uploading.status === 'uploading' ? (
                  <IconButton
                    size="sm"
                    label={t(($) => $.sidebar.pause)}
                    onClick={() => void meeting.uploader.pause()}
                  >
                    <Pause size={17} />
                  </IconButton>
                ) : (
                  ['paused', 'error'].includes(uploading.status) && (
                    <IconButton
                      size="sm"
                      label={t(($) => $.sidebar.resume)}
                      disabled={!writable}
                      onClick={() => meeting.uploader.resume()}
                    >
                      <Play size={17} />
                    </IconButton>
                  )
                )}
                <IconButton
                  size="sm"
                  label={uploading.status === 'done' ? t(($) => $.sidebar.hide) : t(($) => $.sidebar.cancel)}
                  onClick={() => void meeting.uploader.cancel()}
                >
                  <X size={17} />
                </IconButton>
              </div>
              {uploading.error && <p className="form-error">{uploading.error}</p>}
            </div>
          )}
          {refusal && (
            <p className="composer-refusal" role="alert">
              {refusal}
            </p>
          )}
          <ChatAttachments
            files={pending}
            onRemove={(id) => setPending((current) => current.filter((item) => item.id !== id))}
          />
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <IconButton
              label={t(($) => $.sidebar.attach)}
              className="composer__attach"
              disabled={!writable}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip size={19} />
            </IconButton>
            <textarea
              ref={input}
              className="composer__input"
              aria-label={t(($) => $.sidebar.message)}
              placeholder={ended ? t(($) => $.sidebar.ended) : t(($) => $.sidebar.placeholder)}
              rows={1}
              maxLength={4000}
              value={draft}
              disabled={!writable}
              onChange={(e) => {
                setDraft(e.target.value);
                if (refusal) setRefusal('');
              }}
              onPaste={(e) => {
                // Скриншот из буфера — вложением с превью (R94); текст вставляется как обычно.
                const image = pastedImage(e.clipboardData);
                if (!image) return;
                e.preventDefault();
                attach([image]);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <IconButton
              label={t(($) => $.sidebar.send)}
              type="submit"
              className="composer__send"
              disabled={(!draft.trim() && !pending.length) || sending || !writable}
            >
              <Send size={18} />
            </IconButton>
          </form>
          {feedback && (
            <p className="chat-feedback" role="status">
              {feedback}
            </p>
          )}
        </TabPanel>
        <TabPanel value="services" className="panel-body service-body">
          <Services meeting={meeting} />
        </TabPanel>
      </Tabs>
      {error && (
        <p role="alert" className="form-error panel-error">
          {error}
        </p>
      )}
    </aside>
  );
}

/**
 * Лицо в списке с кольцом говорящего — той же ступенью громкости, что обводка плитки (T23).
 * Своя подписка: ступень перерисовывает кольцо, а не весь список.
 */
function VoiceAvatar({ meeting, person }: { meeting: Meeting; person: Participant }) {
  const tier = useVoiceTier(meeting, person.id);
  return (
    <span className="voice-avatar" data-voice={tier || undefined}>
      <Avatar name={person.name} src={person.avatar} />
    </span>
  );
}
