/**
 * SDK звонка по требованию — одним обещанием на страницу. Его не тянут в первую загрузку главная и прихожая
 * (`vite.config.ts` → `startupBudget`), а кто ждёт его (проверка микрофона и камеры, тест), ждёт один и тот
 * же объект: каждый `import()` — своя цепочка неизвестной длины, и тест не мог дождаться цепочки компонента.
 */
let sdk: Promise<typeof import('livekit-client')> | undefined;

export function loadSdk(): Promise<typeof import('livekit-client')> {
  return (sdk ??= import('livekit-client'));
}
