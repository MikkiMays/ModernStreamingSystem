import { describe, expect, it } from 'vitest';
import {
  browserName,
  diagnosticsText,
  noteError,
  recentErrors,
  systemName,
  ticket,
  ticketProblem,
} from './support';

const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

describe('support form', () => {
  it('refuses a message too short to act on', () => {
    expect(ticketProblem('  ой  ')).toBe('tooShort');
    expect(ticketProblem('Не слышно собеседника')).toBeNull();
    expect(ticketProblem('x'.repeat(4001))).toBe('tooLong');
  });

  it('sends diagnostics only with consent, and no empty contact', () => {
    expect(ticket('camera', ' Камера чёрная ', '  ', false, 'cord: 1')).toEqual({
      topic: 'camera',
      message: 'Камера чёрная',
      contact: null,
      diagnostics: null,
      consent: false,
    });
    expect(ticket('other', 'Текст обращения', ' @me ', true, 'cord: 1')).toMatchObject({
      contact: '@me',
      diagnostics: 'cord: 1',
      consent: true,
    });
  });
});

describe('diagnostics', () => {
  it('names the browser and the system without guessing versions it cannot know', () => {
    expect(browserName(CHROME_WIN)).toBe('Chrome 141');
    expect(browserName(EDGE)).toBe('Edge 141');
    expect(browserName(IPHONE)).toBe('Safari 18');
    expect(systemName(CHROME_WIN)).toBe('Windows');
    expect(systemName(IPHONE)).toBe('iOS');
    expect(systemName(ANDROID)).toBe('Android');
  });

  it('is exactly what the preview shows: client, browser, system and recent errors', () => {
    const text = diagnosticsText(
      { userAgent: ANDROID, language: 'ru-RU', screen: '412×915 @2.6x', network: '4g', desktop: undefined },
      ['20:01:02 403 PROOF_INVALID'],
    );
    expect(text.split('\n')).toEqual([
      expect.stringMatching(/^cord: \d+\.\d+\.\d+/),
      'client: web',
      'browser: Chrome 141',
      'os: Android',
      'language: ru-RU',
      'screen: 412×915 @2.6x',
      'network: 4g',
      'errors:',
      '  20:01:02 403 PROOF_INVALID',
    ]);
    expect(
      diagnosticsText({ userAgent: CHROME_WIN, language: 'ru', screen: 's', desktop: '1.0.0' }, []),
    ).toContain('client: windows 1.0.0\n');
  });

  it('keeps ten recent errors without addresses', () => {
    for (let i = 0; i < 12; i++) noteError(`failed https://meet.example.com/api/v1/rooms/${i} #${i}`);
    const log = recentErrors();
    expect(log).toHaveLength(10);
    expect(log.at(-1)).toMatch(/failed … #11$/);
    expect(log.join('\n')).not.toContain('example.com');
  });
});
