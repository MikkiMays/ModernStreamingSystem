export const TOKENS_PATH: string;
export function declarations(css: string, matches: (selector: string) => boolean): Record<string, string>;
export function theme(css: string, name: 'light' | 'dark' | 'stage'): Record<string, string>;
export function resolve(vars: Record<string, string>, value: string, depth?: number): string;
export function parse(value: string): [number, number, number, number];
export function contrast(fg: string, bg: string): number;
export function layer(top: string, base: string): string;
export function mix(a: string, b: string, k: number): string;
export const BRAND_DARKEN: number;
export const BRAND: Record<string, string>;
export const PAIRS: Record<'light' | 'dark' | 'stage', [string, string, number][]>;
export function check(
  css?: string,
): { theme: string; fg: string; bg: string; min: number; ratio: number; ok: boolean }[];
