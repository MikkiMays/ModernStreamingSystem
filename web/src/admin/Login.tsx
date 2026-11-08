import { useState, type FormEvent } from 'react';
import { Button, Field, Input } from '../ui/kit';
import { text } from '../i18n/admin/ru';
import { FleetError, failureText, fleet } from './api';

/** Вход в пульт (Р-113): пароль + одноразовый код; ошибка одна на все причины. */
export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fleet.post('/auth/login', { password, code });
      onDone();
    } catch (failure) {
      if (failure instanceof FleetError && failure.code === 'AUTH_DISABLED') setError(text.login.disabled);
      else setError(failureText(failure));
    } finally {
      setBusy(false);
      setCode('');
    }
  };
  return (
    <form className="admin-login" onSubmit={submit}>
      <p>{text.login.hint}</p>
      <Field label={text.login.password}>
        <Input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          autoFocus
        />
      </Field>
      <Field label={text.login.code} error={error}>
        <Input
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]*"
          maxLength={7}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          required
        />
      </Field>
      <Button type="submit" variant="primary" loading={busy}>
        {text.login.signIn}
      </Button>
    </form>
  );
}
