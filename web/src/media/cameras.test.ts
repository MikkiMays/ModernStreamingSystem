import { describe, expect, it } from 'vitest';
import { classifyCameras, type CameraInput } from './cameras';

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
        classifyCameras([
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
        classifyCameras([
          camera('1', 'Front Camera'),
          camera('2', 'Back Camera'),
          camera('3', 'Back Ultra Wide Camera'),
        ]),
      ),
    ).toEqual(['Фронтальная', 'Основная', 'Широкоугольная']);
  });

  it('берёт по две на сторону и не больше четырёх всего', () => {
    const list = classifyCameras([
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
    const list = classifyCameras([
      camera('1', 'Back Telephoto Camera'),
      camera('2', 'Back Camera'),
      camera('3', 'Front Camera'),
    ]);
    expect(list.find((c) => c.side === 'environment' && c.primary)?.deviceId).toBe('2');
  });

  it('молчит, когда сторону назвать нечем: это не телефон', () => {
    expect(classifyCameras([camera('1', 'HD Webcam C920'), camera('2', 'OBS Virtual Camera')])).toEqual([]);
  });

  it('молчит про одну камеру: одна камера — это не выбор', () => {
    expect(classifyCameras([camera('1', 'Front Camera', ['user'])])).toEqual([]);
  });

  it('пропускает устройства без идентификатора: разрешения ещё не дали', () => {
    expect(classifyCameras([camera('', 'Front Camera'), camera('', 'Back Camera')])).toEqual([]);
  });
});
