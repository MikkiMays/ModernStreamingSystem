package dev.mikki.stream.api;

import dev.mikki.stream.access.Identity;
import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.activity.Audit;
import dev.mikki.stream.activity.MeetingStats;
import dev.mikki.stream.activity.Metrics;
import dev.mikki.stream.config.Rate;
import dev.mikki.stream.room.Contracts;
import dev.mikki.stream.shared.Problem;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Locale;
import java.util.function.Supplier;
import org.springframework.stereotype.Component;

/**
 * Вход во встречу глазами статистики и журнала (E10-B): пять дверей ядра — создать, по ссылке, по
 * коду, вернуться, из избранного — проходят здесь, и каждый исход ложится одним способом.
 *
 * <p>УДАЧА — строка журнала ({@code room.created} или {@code participant.joined}) с отпечатком
 * адреса, хэшем профиля, именем на момент входа и кодом встречи; шаг счётчика уникальных устройств;
 * метр {@code cord_joins_total{result="ok"}}.
 *
 * <p>ОТКАЗ — метр с кодом отказа и строка журнала с исходом {@code denied}, но не чаще раза в
 * минуту на адрес и код: скрипт, получающий тысячу 429 в минуту, не должен писать тысячу строк.
 */
@Component
public class Entries {
  private static final Rate DENIALS = Rate.perMinute(1);

  private final Audit audit;
  private final Metrics metrics;
  private final MeetingStats stats;
  private final Secrets secrets;
  private final RateLimits limits;
  private final ClientAddress address;

  public Entries(
      Audit audit,
      Metrics metrics,
      MeetingStats stats,
      Secrets secrets,
      RateLimits limits,
      ClientAddress address) {
    this.audit = audit;
    this.metrics = metrics;
    this.stats = stats;
    this.secrets = secrets;
    this.limits = limits;
    this.address = address;
  }

  /** {@code door}: {@code create}, {@code link}, {@code code}, {@code rejoin}, {@code saved}. */
  public Contracts.Admission admit(
      String door, HttpServletRequest http, Supplier<Contracts.Admission> enter) {
    var key = address.entrant(http);
    var ip = secrets.address(key);
    var profile = Identity.profileHash(http.getHeader(Identity.PROFILE));
    var action = door.equals("create") ? "room.created" : "participant.joined";
    var client = key != null && key.startsWith("actor:") ? "telegram" : null;
    Contracts.Admission admission;
    try {
      admission = enter.get();
    } catch (Problem refused) {
      metrics.joined(door, refused.code().toLowerCase(Locale.ROOT));
      if (!limits.exceeded("audit-denied:" + ip + ":" + refused.code(), DENIALS))
        audit.record(
            Audit.Entry.of(action)
                .denied(refused.code())
                .actor("anonymous", null, null)
                .from(ip, profile)
                .detail("door", door)
                .detail("client", client));
      throw refused;
    }
    metrics.joined(door, "ok");
    stats.device(profile != null ? profile : ip);
    var snapshot = admission.snapshot();
    var name =
        snapshot.participants().stream()
            .filter(p -> p.id().equals(admission.participantId()))
            .map(Contracts.Participant::name)
            .findFirst()
            .orElse(null);
    audit.record(
        Audit.Entry.of(action)
            .room(admission.roomId(), snapshot.code())
            .target(admission.participantId())
            .actor(
                door.equals("create") ? "creator" : "participant", admission.participantId(), name)
            .from(ip, profile)
            .detail("door", door)
            .detail("client", client));
    return admission;
  }
}
