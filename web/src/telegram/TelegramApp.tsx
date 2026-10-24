import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { retryCatalog } from '../core/cinema/reach';
import { useTranslation } from 'react-i18next';
import { Globe, MicOff, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { publicApi } from '../api/client';
import type { Meeting } from '../core/meeting';
import { alreadyInMeeting } from '../core/identity';
import { parseInvite } from '../core/invitation';
import { readPreferences } from '../core/preferences';
import { rememberMeeting } from '../core/recent';
import { thisServer } from '../core/servers';
import { servicesApi, type TelegramEntry } from '../core/services';
import { openConnection, session } from '../core/session';
import { t as translate } from '../i18n';
import { Connect } from '../ui/Connect';
import { Button, Logo } from '../ui/kit';
import { BootGate } from '../ui/loader/BootGate';
import type { Theme } from '../ui/primitives';
import { probeMicrophone } from './media-probe';
import type { TelegramShell } from './sdk';

const MeetingView = lazy(() =>
  import('../ui/MeetingView').then((module) => ({ default: module.MeetingView })),
);
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30000, retry: 1, refetchOnWindowFocus: false } },
});
// Кинозал сам не повторяет ни отказ недоступной площадки, ни вышедший срок: второе ожидание удвоило
// бы «Спрашиваем площадку…», а у отказа есть кнопка «Повторить» (R112).
queryClient.setQueryDefaults(['cinema'], { retry: retryCatalog });

type Step =
  | { kind: 'entering' }
  | { kind: 'connect' }
  | { kind: 'failed'; message: string; other: string | null }
  | { kind: 'media'; entry: TelegramEntry; reason: 'denied' | 'unsupported' }
  | { kind: 'room'; meeting: Meeting };

/**
 * Mini App Telegram (E09): кнопка «Открыть встречу» в беседе → сразу встреча, на весь экран.
 *
 * Шаги: связь с сервером (пароль сервера — тем же экраном, что в приложении) → `initData` службе, она
 * проверяет подпись, привязку и членство и отвечает приглашением и именем из Telegram → микрофон →
 * вход по приглашению с этим именем, без поля «Ваше имя» → та же встреча, что в браузере
 * (`MeetingView`), в том же документе: так требует защита по источнику Bot API 10.2.
 *
 * Пока идут первые три шага, на экране статичная загрузка `tg.html`; ошибки — экранами, не алертами.
 */
export function TelegramApp({ shell }: { shell: TelegramShell | null }) {
  return (
    <QueryClientProvider client={queryClient}>
      {shell ? <MiniApp shell={shell} /> : <Outside />}
    </QueryClientProvider>
  );
}

function MiniApp({ shell }: { shell: TelegramShell }) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>({ kind: 'entering' });
  const commandId = useRef(crypto.randomUUID());
  const [theme, setTheme] = useState<Theme>(
    () => (document.documentElement.dataset.theme as Theme | undefined) ?? 'dark',
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const run = useCallback(
    async (options: { entry?: TelegramEntry; microphone?: boolean; leave?: string } = {}) => {
      setStep({ kind: 'entering' });
      try {
        if (!session.get() && !(await openConnection(thisServer().password)).ok) {
          setStep({ kind: 'connect' });
          return;
        }
        const entry = options.entry ?? (await servicesApi.telegramEnter(shell.initData));
        let microphone = options.microphone;
        if (microphone === undefined) {
          const probe = await probeMicrophone();
          if (probe !== 'ok') {
            shell.haptic('error');
            setStep({ kind: 'media', entry, reason: probe });
            return;
          }
          microphone = true;
        }
        const destination = parseInvite(entry.inviteUrl);
        if (destination.kind !== 'invite') throw new Error(translate(($) => $.invite.parseFailed));
        const admission = await publicApi.join(
          destination.roomId,
          { commandId: commandId.current, invite: destination.invite, name: entry.name },
          options.leave,
        );
        // Приглашение беседы — то же, что бот даёт по `/meet`: его можно передать дальше из встречи.
        admission.inviteUrl ??= entry.inviteUrl;
        rememberMeeting(admission);
        const { Meeting } = await import('../core/meeting');
        const meeting = new Meeting(admission, {
          ...readPreferences().devices,
          micOn: microphone,
          cameraOn: false,
        });
        shell.haptic('success');
        shell.confirmClosing(true);
        setStep({ kind: 'room', meeting });
      } catch (error) {
        shell.haptic('error');
        // Повтор после отказа — новая команда входа: ядро помнит ответ на прежнюю.
        commandId.current = crypto.randomUUID();
        setStep({
          kind: 'failed',
          message: (error as Error).message,
          other: alreadyInMeeting(error)?.roomId ?? null,
        });
      }
    },
    // Только `shell`: смена языка во встрече не должна заново входить в неё (текст ошибки — общий `t`).
    [shell],
  );
  useEffect(() => {
    void run();
  }, [run]);

  const leave = () => {
    if (step.kind === 'room') step.meeting.dispose();
    shell.confirmClosing(false);
    shell.back(null);
    shell.close();
  };
  /** Кнопка «Назад» Telegram закрывает открытую панель встречи; без панели её нет. */
  const backTarget = useCallback(
    (close: (() => void) | null) =>
      shell.back(
        close
          ? () => {
              shell.haptic('tap');
              close();
            }
          : null,
      ),
    [shell],
  );

  if (step.kind === 'entering') return null;
  if (step.kind === 'connect')
    return (
      <>
        <Connect onConnected={() => void run()} />
        <BootGate />
      </>
    );
  if (step.kind === 'room')
    return (
      <Suspense fallback={null}>
        <MeetingView
          meeting={step.meeting}
          onHome={leave}
          theme={theme}
          setTheme={setTheme}
          onBackTarget={backTarget}
        />
        <BootGate />
      </Suspense>
    );
  if (step.kind === 'media')
    return (
      <Screen
        icon={<MicOff size={28} />}
        title={t(($) => $.telegram.media.title)}
        body={
          step.reason === 'denied'
            ? t(($) => $.telegram.media.denied)
            : t(($) => $.telegram.media.unsupported)
        }
      >
        <Button
          variant="primary"
          size="lg"
          icon={<Globe />}
          onClick={() => shell.openExternal(step.entry.inviteUrl)}
        >
          {t(($) => $.telegram.media.browser)}
        </Button>
        <Button
          variant="secondary"
          size="lg"
          onClick={() => void run({ entry: step.entry, microphone: false })}
        >
          {t(($) => $.telegram.media.listen)}
        </Button>
      </Screen>
    );
  return (
    <Screen icon={<TriangleAlert size={28} />} title={t(($) => $.telegram.failed.title)} body={step.message}>
      {step.other ? (
        <Button variant="primary" size="lg" onClick={() => void run({ leave: step.other ?? undefined })}>
          {t(($) => $.telegram.failed.leaveOther)}
        </Button>
      ) : (
        <Button variant="primary" size="lg" icon={<RotateCcw />} onClick={() => void run()}>
          {t(($) => $.telegram.failed.retry)}
        </Button>
      )}
      <Button variant="secondary" size="lg" icon={<X />} onClick={leave}>
        {t(($) => $.telegram.failed.close)}
      </Button>
    </Screen>
  );
}

/** Страница открыта не из Telegram: объяснить, откуда она открывается, и дать дорогу в Cord. */
function Outside() {
  const { t } = useTranslation();
  return (
    <Screen title={t(($) => $.telegram.outside.title)} body={t(($) => $.telegram.outside.body)}>
      <a className="ui-button ui-button--primary ui-button--lg" href="/">
        {t(($) => $.telegram.outside.home)}
      </a>
    </Screen>
  );
}

function Screen({
  icon,
  title,
  body,
  children,
}: {
  icon?: ReactNode;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <main className="tg-screen">
      <Logo className="tg-screen__logo" />
      <section className="tg-screen__card" aria-labelledby="tg-screen-title">
        {icon && (
          <span className="tg-screen__icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <h1 id="tg-screen-title">{title}</h1>
        <p>{body}</p>
        <div className="tg-screen__actions">{children}</div>
      </section>
      <BootGate />
    </main>
  );
}
