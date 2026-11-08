import { clientHeaders } from './client-kind';
import { profileSecret } from './identity';

/**
 * События аналитики продукта (R210, `docs/architecture/admin-analytics.md` §2.2): «открыл Cord» —
 * один раз на сессию вкладки или запуск приложения, «дошёл до предвхода» — один раз на сессию.
 * Кто — профиль устройства (`X-Cord-Profile`, ядро хранит не его, а HMAC его хэша), чем — тип
 * клиента. Ни адреса страницы, ни названия встречи, ни имени в событии нет.
 *
 * Аналитика не должна мешать: отправка — `keepalive`, без ожидания, любая ошибка глотается.
 */
export type VisitStage = 'open' | 'prejoin';

const SENT = 'cord:visit:v1:';
const sentHere = new Set<VisitStage>();

function alreadySent(stage: VisitStage): boolean {
  if (sentHere.has(stage)) return true;
  sentHere.add(stage);
  try {
    if (sessionStorage.getItem(SENT + stage)) return true;
    sessionStorage.setItem(SENT + stage, '1');
  } catch {
    /* Без хранилища — раз на загрузку страницы. */
  }
  return false;
}

export function noteVisit(stage: VisitStage): void {
  if (alreadySent(stage)) return;
  try {
    void fetch('/api/v1/visit', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-Cord-Profile': profileSecret(), ...clientHeaders() },
      body: JSON.stringify({ stage }),
    }).catch(() => {});
  } catch {
    /* fetch недоступен — аналитика молчит. */
  }
}

/** Только для тестов: забыть, что уже отправлено в этой загрузке. */
export function resetVisitsForTest(): void {
  sentHere.clear();
}
