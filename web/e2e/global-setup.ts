import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FullConfig } from '@playwright/test';

/**
 * Профиль «уже знакомого» человека — для всех сценариев, кроме знакомства (E13, T34).
 *
 * Свежий профиль видит знакомство: подсказки у «Новой встречи», у пульта и у интеграций. Сценарии
 * встреч, игр и кинозала проверяют не его, поэтому начинают с профиля, который знакомство уже прошёл,
 * — как настоящий человек со второго раза. Свежий профиль берёт себе `e2e/onboarding.spec.ts`.
 */
export const RETURNING = '.local/e2e/returning.json';

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
            value: JSON.stringify({ tour: true, meeting: true, integrations: true }),
          },
        ],
      },
    ],
  };
  mkdirSync(dirname(RETURNING), { recursive: true });
  writeFileSync(RETURNING, JSON.stringify(state));
}
