import { act, render, renderHook } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exitFullscreenWithin, useFullscreen } from './fullscreen';

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

describe('exitFullscreenWithin (R121)', () => {
  it('сворачивает полный экран и его замену, только если развёрнуто что-то внутри слоя', async () => {
    let controls: ReturnType<typeof useFullscreen> | undefined;
    function Probe() {
      const ref = useRef<HTMLDivElement>(null);
      const fullscreen = useFullscreen(ref);
      useEffect(() => {
        controls = fullscreen;
      }, [fullscreen]);
      return (
        <section data-testid="layer">
          <div ref={ref} />
        </section>
      );
    }
    setFullscreenElement(null);
    setFullscreenEnabled(false);
    const view = render(<Probe />);
    await act(async () => controls?.toggle());
    expect(controls?.targetFull).toBe(true);
    // Чужой слой не трогается.
    act(() => exitFullscreenWithin(document.createElement('div')));
    expect(controls?.targetFull).toBe(true);
    act(() => exitFullscreenWithin(view.getByTestId('layer')));
    expect(controls?.targetFull).toBe(false);

    const exit = vi.fn(() => Promise.resolve());
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
    setFullscreenElement(view.getByTestId('layer').firstElementChild);
    exitFullscreenWithin(view.getByTestId('layer'));
    expect(exit).toHaveBeenCalledTimes(1);
    setFullscreenElement(null);
  });
});

describe('полный экран на телефоне (R144, Р-41)', () => {
  it('iPhone во вкладке Safari: плеер — родным полным экраном <video>, без полосы адреса', async () => {
    let controls: ReturnType<typeof useFullscreen> | undefined;
    const enter = vi.fn();
    function Probe() {
      const screen = useRef<HTMLDivElement>(null);
      const video = useRef<HTMLVideoElement>(null);
      const fullscreen = useFullscreen(screen, video);
      useEffect(() => {
        controls = fullscreen;
      }, [fullscreen]);
      return (
        <div ref={screen}>
          <video
            ref={(element) => {
              video.current = element;
              if (element)
                Object.assign(element, { webkitEnterFullscreen: enter, webkitSupportsFullscreen: true });
            }}
          />
        </div>
      );
    }
    setFullscreenElement(null);
    setFullscreenEnabled(false);
    const view = render(<Probe />);
    await act(async () => controls?.toggle());
    expect(enter).toHaveBeenCalledTimes(1);
    expect(controls).toMatchObject({ full: true, targetFull: true });
    await act(async () =>
      view.container.querySelector('video')!.dispatchEvent(new Event('webkitendfullscreen')),
    );
    expect(controls).toMatchObject({ full: false });
  });

  it('метаданных ещё нет — замена на всё окно, а не кнопка, которая ничего не делает', async () => {
    let controls: ReturnType<typeof useFullscreen> | undefined;
    const enter = vi.fn();
    function Probe() {
      const screen = useRef<HTMLDivElement>(null);
      const video = useRef<HTMLVideoElement>(null);
      const fullscreen = useFullscreen(screen, video);
      useEffect(() => {
        controls = fullscreen;
      }, [fullscreen]);
      return (
        <div ref={screen}>
          <video
            ref={(element) => {
              video.current = element;
              if (element)
                Object.assign(element, { webkitEnterFullscreen: enter, webkitSupportsFullscreen: false });
            }}
          />
        </div>
      );
    }
    setFullscreenElement(null);
    setFullscreenEnabled(false);
    render(<Probe />);
    await act(async () => controls?.toggle());
    expect(enter).not.toHaveBeenCalled();
    expect(controls).toMatchObject({ full: true, targetFull: true });
    await act(async () => controls?.toggle());
  });
});
