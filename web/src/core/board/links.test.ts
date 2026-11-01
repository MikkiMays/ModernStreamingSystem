import { describe, expect, it } from 'vitest';
import { isObjectLink, linkTarget } from './links';

/** Ссылки на элементах доски (R176): сайт — можно, объект доски — нельзя. */
const HERE = 'https://cord.example/room/00000000-0000-0000-0000-000000000001';

describe('ссылки на элементах доски', () => {
  it('сайт, почта и телефон открываются', () => {
    expect(linkTarget('https://example.org/a?b=1', HERE)).toEqual({
      kind: 'web',
      href: 'https://example.org/a?b=1',
    });
    expect(linkTarget('  http://example.org  ', HERE)).toEqual({ kind: 'web', href: 'http://example.org/' });
    expect(linkTarget('mailto:anna@example.org', HERE)).toEqual({
      kind: 'web',
      href: 'mailto:anna@example.org',
    });
    expect(linkTarget('tel:+79990000000', HERE).kind).toBe('web');
  });

  it('адрес без схемы — сайт по https', () => {
    expect(linkTarget('example.org', HERE)).toEqual({ kind: 'web', href: 'https://example.org/' });
    expect(linkTarget('www.сайт.рф/страница', HERE).kind).toBe('web');
  });

  it('ссылка на объект этой доски — объект, в любом виде', () => {
    expect(linkTarget(`${HERE}?element=abc`, HERE)).toEqual({ kind: 'object' });
    expect(linkTarget('https://cord.example/?element=abc', HERE)).toEqual({ kind: 'object' });
    expect(linkTarget('cord.example/room/x?element=abc', HERE)).toEqual({ kind: 'object' });
    expect(linkTarget('/room/x?element=abc', HERE)).toEqual({ kind: 'object' });
    expect(linkTarget('?element=abc', HERE)).toEqual({ kind: 'object' });
    expect(isObjectLink(`${HERE}?element=abc`, HERE)).toBe(true);
  });

  it('объект на другом сервере — просто чужой сайт', () => {
    expect(linkTarget('https://excalidraw.com/?element=abc', HERE).kind).toBe('web');
    expect(isObjectLink('https://excalidraw.com/?element=abc', HERE)).toBe(false);
  });

  it('ссылка на свой сервер без объекта — сайт (откроется в новой вкладке, не уведёт со встречи)', () => {
    expect(linkTarget('/download', HERE)).toEqual({ kind: 'web', href: 'https://cord.example/download' });
  });

  it('пусто и опасное не открываются', () => {
    expect(linkTarget('', HERE).kind).toBe('none');
    expect(linkTarget(null, HERE).kind).toBe('none');
    expect(linkTarget('javascript:alert(1)', HERE).kind).toBe('none');
    expect(linkTarget('data:text/html,<b>x</b>', HERE).kind).toBe('none');
    expect(linkTarget('about:blank', HERE).kind).toBe('none');
    expect(isObjectLink('javascript:alert(1)', HERE)).toBe(false);
  });
});
