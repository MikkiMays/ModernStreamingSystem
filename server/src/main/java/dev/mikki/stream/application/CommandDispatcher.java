package dev.mikki.stream.application;

import dev.mikki.stream.activity.Metrics;
import dev.mikki.stream.media.MediaGateway;
import dev.mikki.stream.room.*;
import dev.mikki.stream.shared.Problem;
import org.springframework.stereotype.Service;

/** Commit revocation before the external RPC; reconciliation retries failed removals. */
@Service
public class CommandDispatcher {
  private final RoomService rooms;
  private final MediaGateway media;
  private final Metrics metrics;

  public CommandDispatcher(RoomService rooms, MediaGateway media, Metrics metrics) {
    this.rooms = rooms;
    this.media = media;
    this.metrics = metrics;
  }

  public Contracts.Ack execute(String roomId, String credential, Contracts.Command command) {
    return execute(roomId, credential, command, null);
  }

  /** {@code address} — ключ пределов отправителя (A6: чат считается и на адрес), или null. */
  public Contracts.Ack execute(
      String roomId, String credential, Contracts.Command command, String address) {
    if (command.type().equals("microphone.mute"))
      return rooms.muteMicrophone(
          roomId, credential, command, () -> media.muteMicrophone(roomId, command.targetId()));
    var ack = rooms.command(roomId, credential, command, address);
    /*
     Сеть не пропускает звонок (R149): сигнал до SFU дошёл, а путь для медиа — нет, и в этом входе
     медиа не вставало ни разу. Браузер говорит об этом один раз на вход той же потерей связи с
     уточнением (`option: ice-failed`, `web/src/media/session.ts` → `mediaBlocked`) — и ядро считает
     такой вход исходом входа: дверь он уже прошёл (`ok`), не прошло медиа. Здесь, а не в комнате:
     метры живут в `activity`, и комната о них не знает (`RoomObserver`).
    */
    if (command.type().equals("media.lost") && "ice-failed".equals(command.option()))
      metrics.joined("media", "ice_failed");
    try {
      switch (command.type()) {
        case "leave" ->
            media.remove(roomId, credential.replaceFirst("^Bearer ", "").split("\\.")[0]);
        case "participant.remove" -> media.remove(roomId, command.targetId());
        case "close" -> {
          for (var p : media.participants(roomId)) media.remove(roomId, p.getIdentity());
        }
        default -> {}
      }
    } catch (Problem ignored) {
      /* The admission gate already rejects this identity. */
    }
    return ack;
  }
}
