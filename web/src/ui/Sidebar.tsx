import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { composerHeight, DEFAULT_FILE_MAX_BYTES, formatBytes, oversize } from './chat';
import { useVoiceTier } from './useVoice';
import { ExecutableNote } from './abuse/Notices';
import { ChatText } from './abuse/ChatText';

/** Строки панели — в одном месте, до слоя переводов (E14). */
const TEXT = {
  panel: 'Панель встречи',
  sections: 'Разделы встречи',
  close: 'Закрыть панель',
  titles: { people: 'Участники', chat: 'Чат и файлы', services: 'Боты и интеграции' },
  people: 'Люди',
  chat: 'Чат и файлы',
  services: 'Интеграции',
  invite: 'Пригласить в комнату',
  search: 'Найти участника',
  here: (count: number, seats?: number) => `В этой встрече · ${count}${seats ? ` из ${seats}` : ''}`,
  waiting: 'Ожидает подтверждения',
  joining: 'Подключается',
  recovering: 'Восстанавливает связь',
  owner: 'Организатор',
  member: 'Участник',
  you: ' (Вы)',
  approve: (name: string) => 'Разрешить вход: ' + name,
  remove: (name: string) => 'Исключить: ' + name,
  micOff: 'Микрофон выключен',
  retention: 'Сообщения и файлы исчезнут через час после встречи, максимум через сутки.',
  attach: 'Прикрепить файл',
  log: 'Сообщения и вложения',
  emptyTitle: 'Всё рядом с разговором',
  emptyText: 'Напишите сообщение или прикрепите файл — его можно и просто перетащить сюда.',
  copy: 'Скопировать сообщение',
  copied: 'Сообщение скопировано',
  noClipboard: 'Копирование недоступно в этом браузере',
  copyFailed: 'Не удалось скопировать сообщение',
  someone: 'Участник',
  temporary: 'временный файл',
  download: (name: string) => 'Скачать ' + name,
  unfinished: 'Незавершённая загрузка',
  dropUnfinished: (name: string) => 'Удалить незавершённую загрузку: ' + name,
  filesFailed: 'Не удалось получить вложения. Сообщения остаются доступны.',
  progress: 'Прогресс загрузки',
  paused: 'Приостановлено',
  done: 'Загружено',
  failed: 'Ошибка загрузки',
  pause: 'Приостановить загрузку',
  resume: 'Продолжить загрузку',
  hide: 'Скрыть завершённую загрузку',
  cancel: 'Отменить загрузку',
  message: 'Сообщение',
  ended: 'Встреча завершена',
  placeholder: 'Написать сообщение…',
  send: 'Отправить сообщение',
};

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
  const uploadBusy = ['uploading', 'paused'].includes(uploading.status);
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
  const attach = (file?: globalThis.File) => {
    if (!file || !writable || uploadBusy) return;
    const problem = oversize(file, fileMaxBytes);
    setRefusal(problem ?? '');
    if (problem) return;
    nearBottom.current = true;
    void meeting.uploader.start(file);
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
      if (!navigator.clipboard?.writeText) throw new Error(TEXT.noClipboard);
      await navigator.clipboard.writeText(text);
      setFeedback(TEXT.copied);
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
      feedbackTimer.current = setTimeout(() => setFeedback(''), 2200);
    } catch (e) {
      setFeedback('');
      setError((e as Error).message || TEXT.copyFailed);
    }
  };
  const time = (at: number) => (
    <time dateTime={new Date(at).toISOString()}>
      {new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
    </time>
  );
  return (
    <aside className="side-panel" aria-label={TEXT.panel}>
      <div className="panel-heading">
        <h2>{TEXT.titles[panel]}</h2>
        <IconButton label={TEXT.close} onClick={onClose}>
          <X size={20} />
        </IconButton>
      </div>
      <Tabs value={panel} onValueChange={(v) => setPanel(v as Panel)} className="panel-tabs-root">
        <TabList className="panel-tabs" aria-label={TEXT.sections}>
          <Tab value="people">
            {TEXT.people} <span className="panel-tabs__count">{people.length}</span>
          </Tab>
          <Tab value="chat">{TEXT.chat}</Tab>
          <Tab value="services">{TEXT.services}</Tab>
        </TabList>
        <TabPanel value="people" className="panel-body people-panel">
          <Button variant="secondary" full icon={<UserPlus />} onClick={onInvite}>
            {TEXT.invite}
          </Button>
          <input
            type="search"
            className="people-search"
            aria-label={TEXT.search}
            placeholder={TEXT.search}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="panel-section-label">{TEXT.here(people.length, seats)}</div>
          <div className="participant-list">
            {people
              .filter((p) => p.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
              .map((p) => (
                <ParticipantMenu className="participant-row" key={p.id} meeting={meeting} person={p}>
                  <VoiceAvatar meeting={meeting} person={p} />
                  <div className="participant-info">
                    <strong>
                      {p.name}
                      {p.id === self?.id ? TEXT.you : ''}
                    </strong>
                    <small>
                      {p.status === 'WAITING'
                        ? TEXT.waiting
                        : p.status === 'JOINING'
                          ? TEXT.joining
                          : p.status === 'RECOVERING'
                            ? TEXT.recovering
                            : p.owner
                              ? TEXT.owner
                              : TEXT.member}
                    </small>
                  </div>
                  {allowed(snapshot, meeting.admission.participantId, 'participant.remove') && !p.owner ? (
                    <>
                      {p.status === 'WAITING' &&
                        allowed(snapshot, meeting.admission.participantId, 'participant.approve') && (
                          <IconButton
                            size="sm"
                            label={TEXT.approve(p.name)}
                            onClick={() => void run('participant.approve', p.id)}
                          >
                            <Check size={18} />
                          </IconButton>
                        )}
                      <IconButton
                        size="sm"
                        label={TEXT.remove(p.name)}
                        onClick={() => void run('participant.remove', p.id)}
                      >
                        <UserX size={17} />
                      </IconButton>
                    </>
                  ) : (
                    !tracks.some(
                      (t) => t.participantId === p.id && t.source === Track.Source.Microphone && !t.muted,
                    ) && <MicOff className="participant-muted" size={16} aria-label={TEXT.micOff} />
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
            attach(e.dataTransfer.files[0]);
          }}
        >
          <div className="retention-note">{TEXT.retention}</div>
          <input
            type="file"
            ref={fileInput}
            hidden
            aria-label={TEXT.attach}
            onChange={(e) => {
              attach(e.target.files?.[0]);
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
            aria-label={TEXT.log}
            role="log"
            aria-live="polite"
          >
            {!timeline.length && (
              <div className="chat-empty">
                <span className="chat-empty-icon">
                  <Paperclip size={22} />
                </span>
                <strong>{TEXT.emptyTitle}</strong>
                <p>{TEXT.emptyText}</p>
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
                      label={TEXT.copy}
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
                      {snapshot.participants.find((p) => p.id === entry.file.ownerId)?.name ?? TEXT.someone}
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
                        {formatBytes(entry.file.size)} · {TEXT.temporary}
                      </small>
                      <ExecutableNote file={entry.file} />
                    </div>
                    <IconButton
                      label={TEXT.download(entry.file.name)}
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
                    <small>{TEXT.unfinished}</small>
                  </div>
                  <IconButton
                    label={TEXT.dropUnfinished(file.name)}
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
            {files.isError && <p className="form-error">{TEXT.filesFailed}</p>}
          </div>
          {uploading.status !== 'idle' && (
            <div className="upload-progress">
              <strong>{uploading.name}</strong>
              <progress value={uploading.progress} max={1} aria-label={TEXT.progress} />
              <div>
                <span>
                  {uploading.status === 'paused'
                    ? TEXT.paused
                    : uploading.status === 'done'
                      ? TEXT.done
                      : uploading.status === 'error'
                        ? TEXT.failed
                        : Math.round(uploading.progress * 100) + '%'}
                </span>
                {uploading.status === 'uploading' ? (
                  <IconButton size="sm" label={TEXT.pause} onClick={() => void meeting.uploader.pause()}>
                    <Pause size={17} />
                  </IconButton>
                ) : (
                  ['paused', 'error'].includes(uploading.status) && (
                    <IconButton
                      size="sm"
                      label={TEXT.resume}
                      disabled={!writable}
                      onClick={() => meeting.uploader.resume()}
                    >
                      <Play size={17} />
                    </IconButton>
                  )
                )}
                <IconButton
                  size="sm"
                  label={uploading.status === 'done' ? TEXT.hide : TEXT.cancel}
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
          <form
            className="composer"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!draft.trim() || sending || !writable) return;
              setSending(true);
              setError('');
              try {
                await meeting.command('message.send', draft);
                setDraft('');
                nearBottom.current = true;
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setSending(false);
              }
            }}
          >
            <IconButton
              label={TEXT.attach}
              className="composer__attach"
              disabled={!writable || uploadBusy}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip size={19} />
            </IconButton>
            <textarea
              ref={input}
              className="composer__input"
              aria-label={TEXT.message}
              placeholder={ended ? TEXT.ended : TEXT.placeholder}
              rows={1}
              maxLength={4000}
              value={draft}
              disabled={!writable}
              onChange={(e) => {
                setDraft(e.target.value);
                if (refusal) setRefusal('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <IconButton
              label={TEXT.send}
              type="submit"
              className="composer__send"
              disabled={!draft.trim() || sending || !writable}
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
