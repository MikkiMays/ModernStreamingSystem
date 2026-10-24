import { describe, expect, it, vi } from 'vitest';
import { SpeechDownmix } from './downmix';

/**
 * R113 на приёме: голос раскладывается на оба уха, даже если кто-то (старый клиент, другое
 * устройство) прислал стерео с пустым каналом. Музыка и звук показа остаются стерео.
 */
function fakeContext() {
  const nodes: { channelCount: number; channelCountMode: string; channelInterpretation: string }[] = [];
  const context = {
    createGain: vi.fn(() => {
      const node = {
        channelCount: 2,
        channelCountMode: 'max',
        channelInterpretation: 'speakers',
        disconnect: vi.fn(),
      };
      nodes.push(node);
      return node;
    }),
  } as unknown as AudioContext;
  return { context, nodes };
}
const fakeTrack = () => ({ setWebAudioPlugins: vi.fn(), attachedElements: [] as unknown[] });

describe('сведение речи в моно на приёме', () => {
  it('речи ставит узел сведения: один канал, явно, (L+R)/2', () => {
    const { context, nodes } = fakeContext();
    const downmix = new SpeechDownmix(context);
    const track = fakeTrack();
    expect(downmix.sync('TR_mic', track, true)).toBe(true);
    expect(track.setWebAudioPlugins).toHaveBeenCalledWith([nodes[0]]);
    expect(nodes[0]).toMatchObject({
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
  });

  it('музыку и звук показа не трогает — они стерео', () => {
    const { context } = fakeContext();
    const downmix = new SpeechDownmix(context);
    const track = fakeTrack();
    expect(downmix.sync('TR_music', track, false)).toBe(false);
    expect(track.setWebAudioPlugins).not.toHaveBeenCalled();
  });

  it('у каждой дорожки свой узел: общий смешал бы голоса до громкости участника', () => {
    const { context, nodes } = fakeContext();
    const downmix = new SpeechDownmix(context);
    downmix.sync('A', fakeTrack(), true);
    downmix.sync('B', fakeTrack(), true);
    expect(nodes).toHaveLength(2);
  });

  it('повторный вызов ничего не пересобирает; дорожка стала музыкой — сведение снимается', () => {
    const { context, nodes } = fakeContext();
    const downmix = new SpeechDownmix(context);
    const track = fakeTrack();
    downmix.sync('TR', track, true);
    expect(downmix.sync('TR', track, true)).toBe(false);
    expect(track.setWebAudioPlugins).toHaveBeenCalledTimes(1);
    expect(downmix.sync('TR', track, false)).toBe(true);
    expect(track.setWebAudioPlugins).toHaveBeenLastCalledWith([]);
    expect(nodes[0]!.disconnect).toHaveBeenCalled();
  });

  it('без WebAudio (звук через <audio>) ничего не делает', () => {
    const downmix = new SpeechDownmix(null);
    const track = fakeTrack();
    expect(downmix.sync('TR', track, true)).toBe(false);
    expect(track.setWebAudioPlugins).not.toHaveBeenCalled();
  });
});
