package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import dev.mikki.stream.access.AdminAccess;
import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.access.UploadQuota;
import dev.mikki.stream.config.Allowance;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.shared.Problem;
import org.junit.jupiter.api.Test;

/**
 * Дверь владельца сервера ({@code ADMIN_PASSWORD}) и квота загрузок на адрес (A10) — без контекста
 * Spring.
 */
class OwnerAccessTest {
  private static final long GIB = 1024L * 1024 * 1024;

  private static StreamProperties settings(String adminPassword) {
    var config = mock(StreamProperties.class);
    when(config.sessionSecret()).thenReturn("a-test-session-secret-of-32-chars+");
    when(config.internalSecret()).thenReturn("a-test-internal-secret-of-32-chars");
    when(config.adminPassword()).thenReturn(adminPassword);
    when(config.abuse()).thenReturn(ServerAccessTest.abuse());
    when(config.totalMaxBytes()).thenReturn(10 * GIB);
    return config;
  }

  private static AdminAccess admin(String password) {
    var config = settings(password);
    return new AdminAccess(new Secrets(config), config);
  }

  /** Без пароля в настройках страницы нет вовсе: ни входа, ни ответа о том, что она есть. */
  @Test
  void withoutAPasswordThereIsNoOwnerPage() {
    var admin = admin("  ");
    assertThat(admin.enabled()).isFalse();
    assertThatThrownBy(() -> admin.connect("что угодно"))
        .isInstanceOfSatisfying(
            Problem.class,
            p -> {
              assertThat(p.status()).isEqualTo(404);
              assertThat(p.code()).isEqualTo("ADMIN_DISABLED");
            });
    assertThatThrownBy(() -> admin.require("1.x"))
        .isInstanceOfSatisfying(Problem.class, p -> assertThat(p.status()).isEqualTo(404));
  }

  @Test
  void theOwnerPasswordOpensAndNothingElseDoes() {
    var admin = admin("ключ владельца");
    assertThatThrownBy(() -> admin.connect("ключ владельца "))
        .isInstanceOfSatisfying(
            Problem.class, p -> assertThat(p.code()).isEqualTo("ADMIN_PASSWORD_INVALID"));
    var token = admin.connect("ключ владельца").token();
    assertThat(admin.valid(token)).isTrue();
    admin.require(token);
    assertThatThrownBy(() -> admin.require(null))
        .isInstanceOfSatisfying(
            Problem.class,
            p -> {
              assertThat(p.status()).isEqualTo(401);
              assertThat(p.code()).isEqualTo("ADMIN_REQUIRED");
            });
  }

  /**
   * Токен владельца — не токен гостя: подпись другая, и пароль входа на сервер (`ACCESS_PASSWORD`)
   * страницу не открывает. Сменил владелец пароль — прежние токены перестали действовать.
   */
  @Test
  void aTokenDiesWithItsPasswordAndIsNotAServerSession() {
    var before = admin("старый пароль");
    var token = before.connect("старый пароль").token();
    assertThat(admin("новый пароль").valid(token)).isFalse();
    var config = settings("старый пароль");
    var secrets = new Secrets(config);
    long future = System.currentTimeMillis() / 1000 + 600;
    assertThat(before.valid(future + "." + secrets.derive("server-session:" + future))).isFalse();
  }

  /**
   * Третий гигабайт с одного адреса за сутки — 413 UPLOAD_QUOTA_IP; соседний адрес грузит дальше.
   */
  @Test
  void theThirdGigabyteFromOneAddressInADayIsRefused() {
    var quota = new UploadQuota(RateLimits.inMemory(), settings(""));
    var one = "203.0.113.81:" + System.nanoTime();
    quota.check(one, GIB);
    quota.count(one, GIB);
    quota.check(one, GIB);
    quota.count(one, GIB);
    assertThatThrownBy(() -> quota.check(one, 1))
        .isInstanceOfSatisfying(
            Problem.class,
            p -> {
              assertThat(p.status()).isEqualTo(413);
              assertThat(p.code()).isEqualTo("UPLOAD_QUOTA_IP");
            });
    quota.check("203.0.113.82:" + System.nanoTime(), GIB);
    // У наших служб адреса человека нет — и квоты тоже.
    quota.check(null, 100 * GIB);
  }

  /** Сколько бы ни написали в настройке, один адрес не держит больше пятой части места сервера. */
  @Test
  void noAddressHoldsMoreThanAFifthOfTheServer() {
    var config = settings("");
    var abuse = ServerAccessTest.abuse();
    var ip = abuse.perIp();
    var generous =
        new StreamProperties.Abuse.PerIp(
            ip.roomsCreated(),
            ip.openRooms(),
            ip.admissions(),
            ip.codeJoins(),
            ip.codeMisses(),
            ip.sockets(),
            ip.socketOpens(),
            ip.passwordMisses(),
            ip.signaling(),
            Allowance.parse("50GB per 1 day"),
            ip.waitingPerRoom(),
            ip.chatMessages());
    when(config.abuse())
        .thenReturn(
            new StreamProperties.Abuse(
                abuse.humanCheck(),
                abuse.proofCost(),
                generous,
                abuse.perProfile(),
                abuse.perMember(),
                abuse.server(),
                abuse.blocks()));
    assertThat(new UploadQuota(RateLimits.inMemory(), config).quota().bytes()).isEqualTo(2 * GIB);
  }
}
