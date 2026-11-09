import { isDesktop } from './desktop';
import { currentPlatform } from '../media/platform';

/**
 * Каким клиентом открыт Cord — словом для аналитики ядра (R210, Р-126): заголовок `X-Cord-Client`
 * во всех запросах к ядру (`contracts/headers.md`). Приложение для Windows, приложение для телефона
 * (оболочка Capacitor), Mini App Telegram или обычный браузер — в том числе браузер телефона.
 */
export type ClientKind = 'web' | 'desktop' | 'android' | 'telegram';

export const CLIENT_HEADER = 'X-Cord-Client';

export function clientKind(): ClientKind {
  if (isDesktop()) return 'desktop';
  const platform = currentPlatform();
  if (platform.app) return 'android';
  if (platform.telegram) return 'telegram';
  return 'web';
}

export function clientHeaders(): Record<string, string> {
  return { [CLIENT_HEADER]: clientKind() };
}
