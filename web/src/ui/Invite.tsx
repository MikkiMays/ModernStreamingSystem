import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Link, RefreshCw } from 'lucide-react';
import type { Meeting } from '../core/meeting';
import { Modal, useStore } from './primitives';
import { formatCode } from './Home';

export function Invite({
  meeting,
  open,
  onOpenChange,
}: {
  meeting: Meeting;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invitation = useStore(meeting.invite);
  const snapshot = useStore(meeting.snapshot);
  const link = invitation ?? (snapshot.code ? `${location.origin}/join/${snapshot.code}` : null);
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const owner = snapshot.participants.find((p) => p.id === meeting.admission.participantId)?.owner;
  useEffect(() => {
    let active = true;
    setQr('');
    if (link)
      void QRCode.toDataURL(link, { width: 256, margin: 2, errorCorrectionLevel: 'M' }).then((data) => {
        if (active) setQr(data);
      });
    return () => {
      active = false;
    };
  }, [link]);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Пригласить во встречу"
      description="Отправьте приглашение или предложите отсканировать QR. Вход без регистрации."
    >
      {snapshot.code && (
        <div className="invite-code">
          <span>Код встречи</span>
          <strong>{formatCode(snapshot.code)}</strong>
          <small>По коду организатор подтверждает вход.</small>
        </div>
      )}
      {link ? (
        <>
          <div className="invite-qr">
            {qr && <img src={qr} width={232} height={232} alt="QR-код приглашения во встречу" />}
          </div>
          <div className="invite-link">
            <Link size={18} />
            <input aria-label="Ссылка приглашения" value={link} readOnly onFocus={(e) => e.target.select()} />
          </div>
          <button
            className="button primary full"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                setCopied(true);
              } catch {
                setError('Выделите и скопируйте ссылку вручную');
              }
            }}
          >
            {copied ? <Check size={19} /> : <Copy size={19} />}{' '}
            {copied ? 'Ссылка скопирована' : 'Скопировать приглашение'}
          </button>
        </>
      ) : (
        <p className="muted">
          {owner
            ? 'Создайте приглашение для этой комнаты.'
            : 'Попросите организатора поделиться приглашением.'}
        </p>
      )}
      {owner && (
        <button
          className="button ghost full"
          onClick={async () => {
            try {
              if (invitation) await meeting.command('invite.revoke');
              await meeting.command('invite.create');
              setCopied(false);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <RefreshCw size={16} />
          {invitation ? 'Отозвать ссылку и создать новую' : 'Создать приглашение'}
        </button>
      )}
      <p className="form-footnote">
        Действует 24 часа или до завершения встречи.
        <br />
        Права организатора остаются только у вас.
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </Modal>
  );
}
