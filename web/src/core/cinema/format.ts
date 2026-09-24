/** `1:04:12` для часа с лишним, `4:12` для остального. Ноль и пустота — это прочерк. */
export function clock(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const whole = Math.floor(seconds);
  const parts = [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60];
  return parts[0]
    ? `${parts[0]}:${String(parts[1]).padStart(2, '0')}:${String(parts[2]).padStart(2, '0')}`
    : `${parts[1]}:${String(parts[2]).padStart(2, '0')}`;
}

/** «12 тыс.» вместо 12 345: точное число зрителей никому не нужно, а место занимает. */
export function viewers(count: number | null | undefined): string | null {
  if (!count || count < 0) return null;
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${Math.round(count / 100) / 10} тыс.`;
  return `${Math.round(count / 100_000) / 10} млн`;
}

/** `20141110` от YouTube и `2026-09-19` от Twitch — одной строкой для человека. */
export function published(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 8) return null;
  const date = new Date(
    Number(digits.slice(0, 4)),
    Number(digits.slice(4, 6)) - 1,
    Number(digits.slice(6, 8)),
  );
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}
