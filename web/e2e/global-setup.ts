import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FullConfig } from '@playwright/test';

/**
 * Профиль «уже знакомого» человека — для всех сценариев, кроме знакомства (E13, T34).
 *
 * Свежий профиль видит знакомство — тур по кнопкам главной (во встрече подсказок нет, R27). Сценарии
 * встреч, игр и кинозала проверяют не его, поэтому начинают с профиля, который знакомство уже прошёл,
 * — как настоящий человек со второго раза. Свежий профиль берёт себе `e2e/onboarding.spec.ts`.
 */
export const RETURNING = '.local/e2e/returning.json';

/**
 * Подпись «своя проверка» для аналитики (`contracts/insight.md` §5): `<день UTC>.<HMAC-SHA256(ключ, день)>`.
 * Ключ — `ANALYTICS_PROBE_KEY` из `.env` той установки, против которой идут сценарии; без него сценарии
 * работают как раньше, а их сессии попадут в «неясно» или «автоматику».
 */
export function probeToken(key: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `${day}.${createHmac('sha256', key).update(day).digest('base64url')}`;
}

export default function globalSetup(config: FullConfig) {
  const base = config.projects[0]?.use.baseURL ?? 'http://localhost:5173';
  const state = {
    cookies: [],
    origins: [
      {
        origin: new URL(base).origin,
        localStorage: [
          {
            name: 'cord:onboarding:v1',
            value: JSON.stringify({ tour: true }),
          },
          // Шумодав по умолчанию теперь «Усиленное» (R145), а RNNoise режет поддельный тон Chromium
          // как шум: индикатор речи и уровни в сценариях молчали бы. Сценарии идут на прежнем
          // «Стандартном», выбранном явно; свои условия звука сценарий ставит сам.
          {
            name: 'cord:preferences:v1',
            value: JSON.stringify({ audio: { suppression: 'browser', suppressionChosen: true } }),
          },
          // Сценарии — не люди: с подписью их сессии аналитика относит к «своим проверкам» (R239).
          ...(process.env.ANALYTICS_PROBE_KEY
            ? [{ name: 'cord:probe', value: probeToken(process.env.ANALYTICS_PROBE_KEY) }]
            : []),
        ],
      },
    ],
  };
  mkdirSync(dirname(RETURNING), { recursive: true });
  writeFileSync(RETURNING, JSON.stringify(state));
}
