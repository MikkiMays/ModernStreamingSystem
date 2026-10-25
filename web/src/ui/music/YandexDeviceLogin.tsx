import { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, LoaderCircle, RotateCw } from 'lucide-react';
import QRCode from 'qrcode';
import { useTranslation } from 'react-i18next';
import type { YandexAuthorization, YandexDevicePoll } from '../../core/services';
import { t as translate } from '../../i18n';
import { Button } from '../kit';

/** Чем входить по коду устройства: у встречи — в аккаунт комнаты, у настроек — без комнаты (R39). */
export interface DeviceFlow {
  start: () => Promise<YandexAuthorization>;
  /** Ждём — тот же код; подтвердили — `connected` (без комнаты — с токеном, один раз). */
  poll: (id: string) => Promise<YandexAuthorization | YandexDevicePoll>;
  cancel: (id: string) => Promise<unknown>;
}

/** Чем кончился вход: токен (вход без комнаты) или имя аккаунта комнаты. */
export interface DeviceResult {
  token?: string;
  name?: string | null;
}

/**
 * Вход в Яндекс Музыку по QR-коду — «как в прошлом приложении» (R39), один и тот же в настройках
 * («Аккаунты», без встречи) и в музыке встречи (аккаунт комнаты).
 *
 * Пароль вводится на странице Яндекса, не у нас: Яндекс выдаёт код устройства, QR ведёт на его
 * страницу входа, там человек вводит код и подтверждает вход; служба тем временем спрашивает Яндекс,
 * и подтверждение появляется здесь само. Код живёт пять минут — по истечении «Обновить код». QR
 * рисуется тёмным по белому в обеих темах: так его читает любая камера. Закрыли, не дождавшись, —
 * код у службы отменяется.
 */
export function YandexDeviceLogin({
  flow,
  onDone,
  onError,
}: {
  flow: DeviceFlow;
  onDone: (result: DeviceResult) => void;
  onError?: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [auth, setAuth] = useState<YandexAuthorization | null>(null);
  const [qr, setQr] = useState('');
  const [problem, setProblem] = useState('');
  const [expired, setExpired] = useState(false);
  const [copied, setCopied] = useState(false);
  const [starting, setStarting] = useState(false);
  const pending = useRef<string | null>(null);
  // Вызывающий может собирать `flow` и `onDone` заново на каждой отрисовке — опрос от этого не перезапускается.
  const done = useRef(onDone);
  done.current = onDone;
  const source = useRef(flow);
  source.current = flow;

  const begin = async () => {
    setStarting(true);
    setProblem('');
    setExpired(false);
    setCopied(false);
    try {
      const next = await source.current.start();
      pending.current = next.id;
      setAuth(next);
    } catch (e) {
      const message = (e as Error).message;
      setProblem(message);
      onError?.(message);
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    void begin();
    return () => {
      // Ушли, не дождавшись, — код у службы больше не нужен.
      if (pending.current) void source.current.cancel(pending.current).catch(() => {});
      pending.current = null;
    };
    // Один код на открытие: новый — только по «Обновить код».
  }, []);

  useEffect(() => {
    if (!auth) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await source.current.poll(auth.id);
        if (disposed) return;
        if (value.status === 'connected') {
          pending.current = null;
          setAuth(null);
          done.current({
            token: 'token' in value ? value.token : undefined,
            name: value.name ?? null,
          });
          return;
        }
        if (Date.now() >= value.expiresAt) {
          pending.current = null;
          setAuth(null);
          setExpired(true);
          return;
        }
        timer = setTimeout(() => void poll(), value.interval * 1000);
      } catch (e) {
        if (disposed) return;
        pending.current = null;
        setAuth(null);
        setProblem((e as Error).message);
      }
    };
    timer = setTimeout(() => void poll(), auth.interval * 1000);
    void QRCode.toDataURL(auth.verificationUrl, { width: 320, margin: 1 }).then((value) => {
      if (!disposed) setQr(value);
    });
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [auth]);

  if (expired || problem)
    return (
      <div className="yandex-device yandex-device--over" role="status">
        <p className={problem ? 'yandex-device__problem' : 'yandex-device__note'}>
          {problem || translate(($) => $.music.yandex.expired)}
        </p>
        <Button size="sm" icon={<RotateCw />} loading={starting} onClick={() => void begin()}>
          {t(($) => $.music.yandex.device.refresh)}
        </Button>
      </div>
    );

  if (!auth)
    return (
      <p className="yandex-device__note" role="status">
        <LoaderCircle size={16} className="spin" aria-hidden="true" />{' '}
        {t(($) => $.music.yandex.device.starting)}
      </p>
    );

  return (
    <div className="yandex-device">
      <span className="yandex-device__qr">
        {qr && <img src={qr} alt={t(($) => $.music.yandex.qr)} width={160} height={160} />}
      </span>
      <div className="yandex-device__steps">
        <ol>
          <li>{t(($) => $.music.yandex.device.scan)}</li>
          <li>
            {t(($) => $.music.yandex.device.code)}
            <span className="yandex-device__code">
              <strong>{auth.userCode}</strong>
              <Button
                size="sm"
                variant="quiet"
                icon={<Copy />}
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(auth.userCode)
                    .then(() => setCopied(true))
                    .catch(() => {})
                }
              >
                {copied ? t(($) => $.music.yandex.device.copied) : t(($) => $.music.yandex.device.copy)}
              </Button>
            </span>
          </li>
          <li>{t(($) => $.music.yandex.device.confirm)}</li>
        </ol>
        <a
          className="yandex-device__open"
          href={auth.verificationUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t(($) => $.music.yandex.device.open)}
          <ExternalLink size={16} aria-hidden="true" />
        </a>
        <p className="yandex-device__note" role="status">
          <LoaderCircle size={16} className="spin" aria-hidden="true" />{' '}
          {t(($) => $.music.yandex.device.waiting)}
        </p>
      </div>
    </div>
  );
}
