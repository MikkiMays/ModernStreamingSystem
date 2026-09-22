import { act, render, renderHook } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFullscreen } from './fullscreen';

const setFullscreenElement = (value: Element | null) =>
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value });
const setFullscreenEnabled = (value: boolean) =>
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value });

afterEach(() => vi.restoreAllMocks());

describe('useFullscreen', () => {
  it('binds a ref assigned by a real mounted element', async () => {
    let controls: ReturnType<typeof useFullscreen> | undefined;
    function Probe() {
      const ref = useRef<HTMLDivElement>(null);
      const fullscreen = useFullscreen(ref);
      useEffect(() => {
        controls = fullscreen;
      }, [fullscreen]);
      return <div ref={ref} />;
    }
    setFullscreenElement(null);
    setFullscreenEnabled(false);
    render(<Probe />);

    await act(async () => controls?.toggle());
    expect(controls).toMatchObject({ full: true, targetFull: true });
  });

  it('does not install a rejected fallback after its target unmounts', async () => {
    let controls: ReturnType<typeof useFullscreen> | undefined;
    function Probe() {
      const ref = useRef<HTMLDivElement>(null);
      const fullscreen = useFullscreen(ref);
      useEffect(() => {
        controls = fullscreen;
      }, [fullscreen]);
      return <div ref={ref} data-testid="target" />;
    }
    let rejectRequest!: (error: Error) => void;
    const rejected = new Promise<void>((_resolve, reject) => {
      rejectRequest = reject;
    });
    void rejected.catch(() => {});
    setFullscreenElement(null);
    setFullscreenEnabled(true);
    const view = render(<Probe />);
    Object.assign(view.getByTestId('target'), { requestFullscreen: () => rejected });

    act(() => controls?.toggle());
    view.unmount();
    await act(async () => rejectRequest(new Error('denied')));

    const other = document.createElement('div');
    const otherRef = { current: other };
    const { result } = renderHook(() => useFullscreen(otherRef));
    expect(result.current.full).toBe(false);
  });

  it('shares the icon state while preserving the target that owns native fullscreen', () => {
    const first = document.createElement('div');
    const second = document.createElement('div');
    const firstRef = { current: first };
    const secondRef = { current: second };
    setFullscreenElement(null);
    const { result } = renderHook(() => ({
      first: useFullscreen(firstRef),
      second: useFullscreen(secondRef),
    }));

    expect(result.current.first).toMatchObject({ full: false, targetFull: false });
    expect(result.current.second).toMatchObject({ full: false, targetFull: false });

    act(() => {
      setFullscreenElement(first);
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(result.current.first).toMatchObject({ full: true, targetFull: true });
    expect(result.current.second).toMatchObject({ full: true, targetFull: false });

    act(() => {
      Object.assign(document, {
        exitFullscreen: vi.fn(() => {
          setFullscreenElement(null);
          document.dispatchEvent(new Event('fullscreenchange'));
          return Promise.resolve();
        }),
      });
      result.current.second.toggle();
    });
    expect(result.current.first.full).toBe(false);
    expect(result.current.second.full).toBe(false);
  });

  it('shares and exits the fallback state after a browser fullscreen rejection', async () => {
    const first = document.createElement('div');
    const second = document.createElement('div');
    const firstRef = { current: first };
    const secondRef = { current: second };
    setFullscreenElement(null);
    setFullscreenEnabled(true);
    Object.assign(first, { requestFullscreen: vi.fn(() => Promise.reject(new Error('denied'))) });
    const { result } = renderHook(() => ({
      first: useFullscreen(firstRef),
      second: useFullscreen(secondRef),
    }));

    await act(async () => {
      result.current.first.toggle();
      await Promise.resolve();
    });
    expect(result.current.first).toMatchObject({ full: true, targetFull: true });
    expect(result.current.second).toMatchObject({ full: true, targetFull: false });

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(result.current.first.full).toBe(false);
    expect(result.current.second.full).toBe(false);
  });

  it('never treats two null refs as the same fullscreen target', () => {
    setFullscreenElement(null);
    const ref = { current: null };
    const { result } = renderHook(() => useFullscreen(ref));
    expect(result.current).toMatchObject({ full: false, targetFull: false });
  });
});
