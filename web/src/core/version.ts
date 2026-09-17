/**
 * Какую сборку вы сейчас видите.
 *
 * До этого в углу главной стояла надпись «CORD / 01» — литерал, не связанный ни с версией
 * пакета, ни с коммитом, ни с чем бы то ни было ещё. Она выглядела как версия и поэтому
 * была хуже, чем её отсутствие: на вопрос «какая у тебя сборка» она отвечала неправдой.
 *
 * Числа подставляются на сборке (`vite.config.ts`), а не запрашиваются у сервера: страница
 * и есть то, что сервер отдал, и спрашивать его о ней — лишний круг.
 */
declare const __CORD_VERSION__: string;
declare const __CORD_BUILD__: string;

export const appVersion = typeof __CORD_VERSION__ === 'string' ? __CORD_VERSION__ : '0.0.0';
export const appBuild = typeof __CORD_BUILD__ === 'string' ? __CORD_BUILD__ : '';

/** «0.7.0 · a1b2c3d», или просто версия, когда сборка шла без git. */
export const appLabel = appBuild ? `${appVersion} · ${appBuild}` : appVersion;
