import { describe, expect, it } from 'vitest';
import { t } from '../i18n';
import { classifyCameras, lensesFor, type CameraInput } from './cameras';

const camera = (deviceId: string, label: string, facingMode?: string[]): CameraInput => ({
  deviceId,
  label,
  facingMode,
});
const labels = (list: ReturnType<typeof classifyCameras>) => list.map((c) => c.label);

describe('какие камеры предлагать', () => {
  /** Android Chrome: имена вида «camera2 N, facing back», возможности платформа отдаёт. */
  it('находит широкоугольную по возможностям и названию', () => {
    expect(
      labels(
        classifyCameras(t, [
          camera('1', 'camera2 0, facing front', ['user']),
          camera('2', 'camera2 1, facing back', ['environment']),
          camera('3', 'camera2 2, facing back ultra wide', ['environment']),
        ]),
      ),
    ).toEqual(['Фронтальная', 'Основная', 'Широкоугольная']);
  });

  /** iOS Safari называет камеры словами и возможностей не сообщает. */
  it('обходится одними названиями, когда возможностей нет', () => {
    expect(
      labels(
        classifyCameras(t, [
          camera('1', 'Front Camera'),
          camera('2', 'Back Camera'),
          camera('3', 'Back Ultra Wide Camera'),
        ]),
      ),
    ).toEqual(['Фронтальная', 'Основная', 'Широкоугольная']);
  });

  it('берёт по две на сторону и не больше четырёх всего', () => {
    const list = classifyCameras(t, [
      camera('1', 'Front Camera'),
      camera('2', 'Front Wide Camera'),
      camera('3', 'Back Camera'),
      camera('4', 'Back Ultra Wide Camera'),
      camera('5', 'Back Telephoto Camera'),
      camera('6', 'Back Dual Camera'),
    ]);
    expect(list.length).toBe(4);
    expect(list.filter((c) => c.side === 'environment').map((c) => c.deviceId)).toEqual(['3', '4']);
  });

  /** Телефото и глубина рядом с двумя понятными кнопками — шум, а не выбор. */
  it('не предлагает телефото и датчик глубины как основную', () => {
    const list = classifyCameras(t, [
      camera('1', 'Back Telephoto Camera'),
      camera('2', 'Back Camera'),
      camera('3', 'Front Camera'),
    ]);
    expect(list.find((c) => c.side === 'environment' && c.primary)?.deviceId).toBe('2');
  });

  it('молчит, когда сторону назвать нечем: это не телефон', () => {
    expect(classifyCameras(t, [camera('1', 'HD Webcam C920'), camera('2', 'OBS Virtual Camera')])).toEqual(
      [],
    );
  });

  it('молчит про одну камеру: одна камера — это не выбор', () => {
    expect(classifyCameras(t, [camera('1', 'Front Camera', ['user'])])).toEqual([]);
  });

  it('пропускает устройства без идентификатора: разрешения ещё не дали', () => {
    expect(classifyCameras(t, [camera('', 'Front Camera'), camera('', 'Back Camera')])).toEqual([]);
  });
});

describe('переключатель линз на своей плитке (T21)', () => {
  const phone = classifyCameras(t, [
    camera('front', 'Front Camera'),
    camera('back', 'Back Camera'),
    camera('wide', 'Back Ultra Wide Camera'),
  ]);

  it('на задней стороне с широкоугольной — «0.5×» и «1×», горит та, что снимает', () => {
    expect(lensesFor(phone, { deviceId: 'back', facingMode: 'environment' })).toEqual([
      { deviceId: 'wide', short: '0.5×', label: 'Широкоугольная', active: false, wide: true },
      { deviceId: 'back', short: '1×', label: 'Основная', active: true, wide: false },
    ]);
    expect(lensesFor(phone, { deviceId: 'wide' })?.find((lens) => lens.active)?.short).toBe('0.5×');
  });

  it('на фронтальной с одной линзой переключателя нет', () => {
    expect(lensesFor(phone, { deviceId: 'front', facingMode: 'user' })).toBeNull();
  });

  it('браузер выбрал линзу сам — сторона по facingMode, горит основная', () => {
    const lenses = lensesFor(phone, { deviceId: 'virtual-triple', facingMode: 'environment' });
    expect(lenses?.map((lens) => [lens.short, lens.active])).toEqual([
      ['0.5×', false],
      ['1×', true],
    ]);
  });

  it('вторая линза без слова «широкоугольная» — «1» и «2», без обещаний', () => {
    const android = classifyCameras(t, [
      camera('0', 'camera2 0, facing back', ['environment']),
      camera('2', 'camera2 2, facing back', ['environment']),
      camera('1', 'camera2 1, facing front', ['user']),
    ]);
    expect(lensesFor(android, { deviceId: '0' })?.map((lens) => lens.short)).toEqual(['1', '2']);
  });

  it('настольная камера — ни стороны, ни переключателя', () => {
    expect(lensesFor([], { deviceId: 'webcam' })).toBeNull();
  });
});
