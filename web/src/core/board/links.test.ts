import { describe, expect, it } from 'vitest';
import { fixLink, linkTarget } from './links';

/** Ссылки на элементах доски (R176): сайт — можно, объект доски — нельзя. */
const HERE = 'https://cord.example/room/00000000-0000-0000-0000-000000000001';

describe('ссылки на элементах доски', () => {
  it('сайт и почта открываются', () => {
    expect(linkTarget('https://example.org/a?b=1', HERE)).toEqual({
      kind: 'web',
      href: 'https://example.org/a?b=1',
    });
    expect(linkTarget('  http://example.org  ', HERE)).toEqual({ kind: 'web', href: 'http://example.org/' });
    expect(linkTarget('mailto:anna@example.org', HERE)).toEqual({
      kind: 'web',
      href: 'mailto:anna@example.org',
    });
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
  });

  it('объект на другом сервере — просто чужой сайт', () => {
    expect(linkTarget('https://excalidraw.com/?element=abc', HERE).kind).toBe('web');
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
    // Телефон ядро не принимает (`BoardRoom.safeLink`) — и доска его не открывает.
    expect(linkTarget('tel:+79990000000', HERE).kind).toBe('none');
  });

  it('правка ссылки: годную не трогать, сайт без схемы — до https, объект и прочее — снять', () => {
    expect(fixLink(null, HERE)).toBeNull();
    expect(fixLink('', HERE)).toBeNull();
    expect(fixLink('https://example.org', HERE)).toBeNull();
    expect(fixLink('HTTP://Example.org/a', HERE)).toBeNull();
    expect(fixLink('mailto:anna@example.org', HERE)).toBeNull();
    expect(fixLink('example.org', HERE)).toEqual({ link: 'https://example.org/', reason: 'normalized' });
    expect(fixLink('/download', HERE)).toEqual({
      link: 'https://cord.example/download',
      reason: 'normalized',
    });
    expect(fixLink(`${HERE}?element=abc`, HERE)).toEqual({ link: null, reason: 'object' });
    expect(fixLink('javascript:alert(1)', HERE)).toEqual({ link: null, reason: 'unsupported' });
    expect(fixLink('tel:+79990000000', HERE)).toEqual({ link: null, reason: 'unsupported' });
    expect(fixLink(`https://example.org/${'a'.repeat(2048)}`, HERE)).toEqual({
      link: null,
      reason: 'unsupported',
    });
  });
});
