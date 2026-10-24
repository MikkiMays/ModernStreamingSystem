/**
 * Голос собеседника — в оба уха (R113).
 *
 * ПОЧЕМУ НА ПРИЁМЕ, ЕСЛИ МИКРОФОН И ТАК ПУБЛИКУЕТСЯ МОНО. Владелец: «бывает, что участника слышно
 * только в левом ухе, и так с разными участниками». Корень — у отправителя: гарнитура или веб-камера
 * отдают микрофон двумя каналами, из которых звучит один, LiveKit видит `channelCount: 2` и публикует
 * стерео Opus, а шумоподавление RNNoise обрабатывает только первый канал и второй оставляет нулями.
 * Это чинится в `audio.ts` (моно в публикации и после обработки), но только у тех, кто обновился:
 * старый клиент Windows, закешированная страница или чужое устройство пришлют стерео с пустым
 * каналом и дальше. Поэтому речь сводится в моно ещё и здесь — тогда WebAudio разложит её на оба
 * уха сам, кто бы и как бы её ни прислал.
 *
 * Сведение — узел усиления с одним явным каналом и правилами «динамиков»: (L+R)/2. Голос, который
 * пришёл одинаковым в обоих каналах, от этого не меняется; голос в одном канале становится на 6 дБ
 * тише, но звучит в обоих ушах. Музыка и звук показа — стерео по замыслу, их это не касается.
 *
 * Узел у каждой дорожки свой: LiveKit включает его между источником и громкостью участника, и
 * общий узел смешал бы голоса до того, как каждому выставлена своя громкость.
 */

export interface DownmixTrack {
  setWebAudioPlugins(nodes: AudioNode[]): void;
}

export class SpeechDownmix {
  private nodes = new Map<string, AudioNode>();
  constructor(private context: AudioContext | null) {}

  /**
   * Поставить или снять сведение у дорожки. Возвращает `true`, если цепочка пересобрана: тогда
   * LiveKit заново создал узел громкости, и громкость участника нужно выставить снова.
   */
  sync(id: string, track: DownmixTrack, speech: boolean): boolean {
    if (!this.context) return false;
    const current = this.nodes.get(id);
    if (speech === !!current) return false;
    if (speech) {
      const node = this.context.createGain();
      node.channelCount = 1;
      node.channelCountMode = 'explicit';
      node.channelInterpretation = 'speakers';
      this.nodes.set(id, node);
      track.setWebAudioPlugins([node]);
    } else {
      this.nodes.delete(id);
      track.setWebAudioPlugins([]);
      current!.disconnect();
    }
    return true;
  }

  forget(id: string) {
    this.nodes.get(id)?.disconnect();
    this.nodes.delete(id);
  }
}
