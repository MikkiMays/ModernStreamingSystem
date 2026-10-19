import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetPanelWidths, usePanelWidth } from './usePanelWidth';

const options = { min: 240, max: 480, default: 320 };

describe('usePanelWidth', () => {
  beforeEach(forgetPanelWidths);

  it('без сохранённого значения отдаёт ширину по умолчанию', () => {
    const { result } = renderHook(() => usePanelWidth('home', options));
    expect(result.current.width).toBe(320);
  });

  it('запоминает ширину в localStorage и зажимает в пределах', () => {
    const { result } = renderHook(() => usePanelWidth('home', options));
    act(() => result.current.setWidth(400));
    expect(result.current.width).toBe(400);
    expect(localStorage.getItem('cord:panel:home')).toBe('400');
    act(() => result.current.setWidth(9999));
    expect(result.current.width).toBe(480);
    act(() => result.current.setWidth(-5));
    expect(result.current.width).toBe(240);
    act(() => result.current.setWidth((w) => w + 16));
    expect(result.current.width).toBe(256);
  });

  it('читает сохранённое при монтировании и не верит значению вне пределов', () => {
    localStorage.setItem('cord:panel:meeting', '360');
    const { result } = renderHook(() => usePanelWidth('meeting', options));
    expect(result.current.width).toBe(360);
    localStorage.setItem('cord:panel:wide', '900');
    const wide = renderHook(() => usePanelWidth('wide', options));
    expect(wide.result.current.width).toBe(480);
    localStorage.setItem('cord:panel:junk', 'abc');
    const junk = renderHook(() => usePanelWidth('junk', options));
    expect(junk.result.current.width).toBe(320);
  });

  it('reset возвращает ширину по умолчанию и чистит хранилище', () => {
    const { result } = renderHook(() => usePanelWidth('home', options));
    act(() => result.current.setWidth(300));
    act(() => result.current.reset());
    expect(result.current.width).toBe(320);
    expect(localStorage.getItem('cord:panel:home')).toBeNull();
  });

  it('две панели с одним ключом видят одно значение', () => {
    const a = renderHook(() => usePanelWidth('shared', options));
    const b = renderHook(() => usePanelWidth('shared', options));
    act(() => a.result.current.setWidth(444));
    expect(b.result.current.width).toBe(444);
  });
});
