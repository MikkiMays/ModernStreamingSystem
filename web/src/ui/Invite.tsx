import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Link, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { allowed } from '../core/permissions';
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
  const { t } = useTranslation();
  const invitation = useStore(meeting.invite);
  const snapshot = useStore(meeting.snapshot);
  const link = invitation ?? (snapshot.code ? `${location.origin}/join/${snapshot.code}` : null);
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const owner = allowed(snapshot, meeting.admission.participantId, 'invite.manage');
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
      title={t(($) => $.invite.dialog.title)}
      description={t(($) => $.invite.dialog.description)}
    >
      {snapshot.code && (
        <div className="invite-code">
          <span>{t(($) => $.invite.dialog.code)}</span>
          <strong>{formatCode(snapshot.code)}</strong>
          <small>{t(($) => $.invite.dialog.codeHint)}</small>
        </div>
      )}
      {link ? (
        <>
          <div className="invite-qr">
            {qr && <img src={qr} width={232} height={232} alt={t(($) => $.invite.dialog.qr)} />}
          </div>
          <div className="invite-link">
            <Link size={18} />
            <input
              aria-label={t(($) => $.invite.dialog.link)}
              value={link}
              readOnly
              onFocus={(e) => e.target.select()}
            />
          </div>
          <button
            className="button primary full"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                setCopied(true);
              } catch {
                setError(t(($) => $.invite.dialog.copyManually));
              }
            }}
          >
            {copied ? <Check size={19} /> : <Copy size={19} />}{' '}
            {copied ? t(($) => $.invite.dialog.copied) : t(($) => $.invite.dialog.copy)}
          </button>
        </>
      ) : (
        <p className="muted">
          {owner ? t(($) => $.invite.dialog.create) : t(($) => $.invite.dialog.askOwner)}
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
          {invitation ? t(($) => $.invite.dialog.renew) : t(($) => $.invite.dialog.createButton)}
        </button>
      )}
      <p className="form-footnote">
        {t(($) => $.invite.dialog.validity)}
        <br />
        {t(($) => $.invite.dialog.ownerRights)}
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </Modal>
  );
}
