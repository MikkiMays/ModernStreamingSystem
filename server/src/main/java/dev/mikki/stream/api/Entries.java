package dev.mikki.stream.api;

import dev.mikki.stream.access.Identity;
import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.activity.Audit;
import dev.mikki.stream.activity.ClientKind;
import dev.mikki.stream.activity.InsightFacts;
import dev.mikki.stream.activity.MeetingStats;
import dev.mikki.stream.activity.Metrics;
import dev.mikki.stream.activity.Participants;
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
 *
 * <p>ЖУРНАЛ УЧАСТНИКОВ (Р-134) — строка удачного входа с полным адресом, клиентом, узлом и
 * названием встречи ({@link Participants}): после фиксации входа, в буфер, — вход его не ждёт.
 *
 * <p>АНАЛИТИКА (R239) — факт {@code join} удачному входу и {@code join_fail} отказу двери ({@link
 * InsightFacts}, {@code contracts/insight.md} §2): в буфер, после того как дверь ответила, — вне
 * транзакции встречи. Отказ больше никого не делает «посетителем»: человека в аналитике создаёт
 * только его собственное действие, это решает служба. Фактов об отказах с одного адреса — не больше
 * {@link #FAILS} в минуту: поток отказов скрипту считается итогом минуты ({@code refusal}), а не
 * фактом на каждый.
 */
@Component
public class Entries {
  private static final Rate DENIALS = Rate.perMinute(1);

  /** Фактов {@code join_fail} с одного адреса в минуту — столько же, сколько входов ему можно. */
  static final Rate FAILS = Rate.perMinute(30);

  private final Audit audit;
  private final InsightFacts facts;
  private final Metrics metrics;
  private final MeetingStats stats;
  private final Secrets secrets;
  private final RateLimits limits;
  private final ClientAddress address;
  private final Participants participants;

  public Entries(
      Audit audit,
      InsightFacts facts,
      Metrics metrics,
      MeetingStats stats,
      Secrets secrets,
      RateLimits limits,
      ClientAddress address,
      Participants participants) {
    this.participants = participants;
    this.audit = audit;
    this.facts = facts;
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
    // Полный адрес — для журнала и журнала участников (Р-134); отпечаток `ip` — для блоков.
    var full = address.ip(http);
    var profile = Identity.profileHash(http.getHeader(Identity.PROFILE));
    var action = door.equals("create") ? "room.created" : "participant.joined";
    var client = key != null && key.startsWith("actor:") ? "telegram" : null;
    var kind = client != null ? ClientKind.of(http).telegram() : ClientKind.of(http);
    Contracts.Admission admission;
    try {
      admission = enter.get();
    } catch (Problem refused) {
      metrics.joined(door, refused.code().toLowerCase(Locale.ROOT));
      if (facts.enabled() && (ip == null || !limits.exceeded("insight-join-fail:" + ip, FAILS)))
        facts
            .fact("join_fail")
            .profile(profile)
            .put("how", door)
            .put("code", refused.code())
            .publish();
      if (!limits.exceeded("audit-denied:" + ip + ":" + refused.code(), DENIALS))
        audit.record(
            Audit.Entry.of(action)
                .denied(refused.code())
                .actor("anonymous", null, null)
                .from(ip, profile)
                .ip(full)
                .detail("door", door)
                .detail("client", client));
      throw refused;
    }
    metrics.joined(door, "ok");
    stats.device(profile != null ? profile : ip);
    participants.joined(door, admission, full, profile, kind);
    var snapshot = admission.snapshot();
    if (facts.enabled())
      facts
          .fact("join")
          .put("room", admission.roomId())
          .profile(profile)
          .put("member", admission.participantId())
          .put("how", door)
          .put("node", snapshot.mediaNode())
          .put("client", kind.client())
          // Повтор того же входа (та же расписка — тот же участник) — тот же факт, а не второй.
          .once(admission.roomId() + ":" + admission.participantId())
          .publish();
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
            .ip(full)
            .detail("door", door)
            .detail("client", client));
    return admission;
  }
}
