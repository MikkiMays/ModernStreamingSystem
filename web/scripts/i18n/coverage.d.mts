// Типы `coverage.mjs` для теста полноты переводов (`src/i18n/coverage.test.ts`).
export interface Audit {
  total: number;
  covered: number;
  problems: string[];
}
export function audit(ru: object, catalog: object, language: string): Audit;
export function pluralCategories(language: string): string[];
export function leaves(node: object): Map<string, unknown>;
export function catalog(language: string): object;
export function languages(): Promise<{
  LANGUAGES: readonly string[];
  TRANSLATED: readonly string[];
  SOURCE: string;
}>;
export const CYRILLIC_ALLOWED: Set<string>;
