import { useCallback, useState } from 'react';
import type { Environment, Machine } from './api';

/**
 * Среда пульта (Р-149): «Продукт» и «Стенд» никогда не складываются; выбор один на весь пульт и переживает
 * перезагрузку. Машина разработки с пультом — стенд, всё остальное — продукт.
 */
const KEY = 'cord:admin:environment';

export const environmentOf = (role: string): Environment => (role === 'dev+admin' ? 'dev' : 'product');

export function readEnvironment(): Environment {
  try {
    return localStorage.getItem(KEY) === 'dev' ? 'dev' : 'product';
  } catch {
    return 'product';
  }
}

export function useEnvironment(): [Environment, (next: Environment) => void] {
  const [environment, setState] = useState<Environment>(readEnvironment);
  const set = useCallback((next: Environment) => {
    setState(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* Выбор среды живёт до перезагрузки. */
    }
  }, []);
  return [environment, set];
}

/** Ядро среды: машина с ядром и учётными данными к нему; у продукта — «ядро продукта», у стенда — сам стенд. */
export function coreOf(machines: Machine[], environment: Environment): Machine | null {
  return (
    machines.find((machine) => machine.core?.credential && environmentOf(machine.role) === environment) ??
    null
  );
}
