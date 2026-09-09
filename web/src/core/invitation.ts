import type { Admission } from '../api/types';
import type { Favorite } from './favorites';

export type Destination =
  | { kind: 'invite'; roomId: string; invite: string }
  | { kind: 'code'; code: string }
  | { kind: 'favorite'; favorite: Favorite }
  | { kind: 'recent'; admission: Admission }
  | { kind: 'telegram'; token: string };

export function formatCode(value: string) {
  return value
    .replace(/\D/g, '')
    .slice(0, 9)
    .replace(/(\d{3})(?=\d)/g, '$1-');
}

export function parseInvite(value: string): Destination {
  if (/^\d{3}-?\d{3}-?\d{3}$/.test(value.trim())) return { kind: 'code', code: value.replace(/\D/g, '') };
  const url = new URL(value.trim(), location.origin);
  if (url.pathname === '/host') {
    const token = new URLSearchParams(url.hash.slice(1)).get('token');
    if (token && /^[A-Za-z0-9_-]{32}$/.test(token)) return { kind: 'telegram', token };
  }
  const code = /^\/join\/(\d{9})$/.exec(url.pathname);
  if (code?.[1]) return { kind: 'code', code: code[1] };
  const match = /^\/join\/([0-9a-f-]{36})$/.exec(url.pathname);
  const invite = new URLSearchParams(url.hash.slice(1)).get('invite');
  if (!match?.[1] || !invite || !/^[A-Za-z0-9_-]{43}$/.test(invite))
    throw new Error('Введите 9 цифр кода или полную ссылку приглашения');
  return { kind: 'invite', roomId: match[1], invite };
}
