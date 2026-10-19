package dev.mikki.stream;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import dev.mikki.stream.access.Entrant;
import dev.mikki.stream.access.Identity;
import dev.mikki.stream.attachment.TusGateway;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.media.*;
import dev.mikki.stream.room.*;
import dev.mikki.stream.room.Contracts.*;
import dev.mikki.stream.shared.Json;
import dev.mikki.stream.shared.Problem;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import org.assertj.core.api.ThrowableAssert;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/**
 * Личность и пределы (WP1): одна активная встреча на профиль устройства (T52), двадцать человек в
 * комнате без ботов и десять комнат в избранном (T06), время встречи (T35).
 *
 * <p>Контекст тот же, что у {@link RoomServiceTest}, — те же свойства и те же подмены, — поэтому
 * Spring поднимает его один раз на оба класса.
 */
@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:rooms;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
      "stream.scheduling-enabled=false",
      "stream.event-history-limit=10",
      "stream.files-root=./.local/test-uploads",
      "stream.max-rooms=200"
    })
@ActiveProfiles("local")
class MeetingLimitsTest {
  @Autowired RoomService rooms;
  @Autowired MediaService media;
  @Autowired Lifecycle lifecycle;
  @Autowired FavoriteService favorites;
  @Autowired StreamProperties config;
  @Autowired JdbcClient jdbc;
  @MockitoBean MediaGateway gateway;
  @MockitoBean TusGateway tus;
  @MockitoBean Clock clock;
  AtomicLong now = new AtomicLong(System.currentTimeMillis());

  /** Секрет профиля устройства — то, что браузер хранит в {@code cord:profile:v1}. */
  static final String SECRET = "P".repeat(43);

  /** Тот же человек, каким его видит ядро: хэш секрета из {@code X-Cord-Profile}. */
  static final Entrant ME = new Entrant(Identity.profileHash(SECRET), null);

  @BeforeEach
  void setUp() {
    jdbc.sql("DELETE FROM command_receipts").update();
    jdbc.sql("DELETE FROM rooms").update();
    when(clock.millis()).thenAnswer(_ -> now.get());
    when(tus.terminate(anyString())).thenReturn(true);
  }

  static Entrant leaving(String roomId) {
    return new Entrant(ME.profileHash(), roomId);
  }

  Admission create(String title, Entrant entrant) {
    return rooms.create(new Create(UUID.randomUUID(), title, "Хозяин", false), entrant);
  }

  /** Встреча, в которой сидит кто-то другой: она не пустеет, когда из неё уходит профиль. */
  Admission someoneElses(String title) {
    return rooms.create(new Create(UUID.randomUUID(), title, "Чужой", false));
  }

  static String invite(Admission host) {
    return host.inviteUrl().split("invite=")[1];
  }

  Admission join(Admission host, Entrant entrant) {
    return rooms.join(host.roomId(), new Join(UUID.randomUUID(), invite(host), "Гость"), entrant);
  }

  Ack command(Admission admission, String type, long generation) {
    return rooms.command(
        admission.roomId(),
        admission.credential(),
        new Command(UUID.randomUUID(), type, null, null, generation));
  }

  RoomState.Member member(Admission admission) {
    return rooms.read(admission.roomId()).members.get(admission.participantId());
  }

  /** Профиль, с которого вошёл участник, как его помнит комната. */
  String profile(Admission admission) {
    return rooms.read(admission.roomId()).profiles.get(admission.participantId());
  }

  static void refusedFor(ThrowableAssert.ThrowingCallable entry, Admission where) {
    assertThatThrownBy(entry)
        .isInstanceOfSatisfying(
            Problem.class,
            problem -> {
              assertThat(problem.status()).isEqualTo(409);
              assertThat(problem.code()).isEqualTo("ALREADY_IN_MEETING");
              assertThat(problem.properties())
                  .containsEntry("roomId", where.roomId())
                  .containsEntry("title", where.snapshot().title());
              assertThat(problem.getMessage()).contains(where.snapshot().title());
            });
  }

  // T52: одна активная встреча на профиль ------------------------------------------------------

  /**
   * Пять дверей во встречу — создать, войти по ссылке, по коду, вернуться и войти из избранного, —
   * и за каждой одно и то же правило: пока профиль живёт в одной встрече, во вторую его не пускают,
   * а отказ называет первую.
   */
  @Test
  void everyDoorRefusesASecondMeetingAndNamesTheFirst() {
    // Две прежние встречи, из которых профиль ушёл: в одну он вернётся по сессии, в другую — из
    // избранного.
    var returning = create("Вчерашняя", ME);
    command(returning, "leave", 0);
    var saved = create("Сохранённая", ME);
    favorites.save(SECRET, saved.roomId(), saved.credential());
    command(saved, "leave", 0);

    var first = create("Первая", ME);
    var second = someoneElses("Вторая");

    refusedFor(() -> create("Ещё одна", ME), first);
    refusedFor(() -> join(second, ME), first);
    refusedFor(
        () ->
            rooms.joinCode(new JoinCode(UUID.randomUUID(), second.snapshot().code(), "Гость"), ME),
        first);
    refusedFor(
        () ->
            rooms.rejoin(
                returning.roomId(),
                returning.credential(),
                new Rejoin(UUID.randomUUID(), "Хозяин"),
                ME),
        first);
    refusedFor(
        () -> favorites.join(SECRET, saved.roomId(), new Rejoin(UUID.randomUUID(), "Хозяин"), ME),
        first);

    // Отказ ничего не тронул: первая встреча идёт, во второй профиля нет.
    assertThat(member(first).status).isEqualTo(RoomState.Status.JOINING);
    assertThat(rooms.read(second.roomId()).profiles).doesNotContainValue(ME.profileHash());

    // Та же встреча во второй вкладке — не вторая встреча.
    assertThat(join(first, ME).roomId()).isEqualTo(first.roomId());
    // Старый клиент без профиля и службы правила не знают: обход новым профилем допустим (П13).
    assertThat(join(second, Entrant.UNKNOWN).roomId()).isEqualTo(second.roomId());
    assertThat(join(second, new Entrant(Identity.profileHash("Q".repeat(43)), null)).roomId())
        .isEqualTo(second.roomId());
  }

  /**
   * «Выйти оттуда и войти сюда» — один шаг: прежнее участие закрывается обычным выходом (его видят
   * остальные), и тот же запрос пускает. Отказ любой двери отменяет и выход.
   */
  @Test
  void leavingTheOtherMeetingAndEnteringIsOneStep() {
    var first = create("Первая", ME);
    var friend = join(first, Entrant.UNKNOWN);
    var second = someoneElses("Вторая");
    long before = rooms.read(first.roomId()).sequence;

    var entered = join(second, leaving(first.roomId()));

    assertThat(entered.roomId()).isEqualTo(second.roomId());
    var left = member(first);
    assertThat(left.status).isEqualTo(RoomState.Status.LEFT);
    assertThat(left.recoveryDeadline).isNull();
    // Остальные узнают о выходе тем же событием, что и об обычном.
    var room = rooms.read(first.roomId());
    assertThat(room.sequence).isGreaterThan(before);
    assertThat(room.closedAt).isNull();
    assertThat(room.members.get(friend.participantId()).status).isEqualTo(RoomState.Status.JOINING);
    assertThat(rooms.snapshot(first.roomId(), friend.credential()).participants())
        .noneMatch(p -> p.id().equals(first.participantId()));

    // Назвать в заголовке не ту встречу — всё равно отказ, и ничего не тронуто.
    var third = someoneElses("Третья");
    refusedFor(() -> join(third, leaving(first.roomId())), entered);
    assertThat(member(entered).status).isEqualTo(RoomState.Status.JOINING);

    // Выход и вход — одна транзакция: дверь, которая отказала по другой причине, не выводит из
    // прежней встречи.
    assertThatThrownBy(
            () ->
                rooms.join(
                    third.roomId(),
                    new Join(UUID.randomUUID(), "не приглашение", "Гость"),
                    leaving(second.roomId())))
        .isInstanceOf(Problem.class)
        .extracting("code")
        .isEqualTo("INVITE_INVALID");
    assertThat(member(entered).status).isEqualTo(RoomState.Status.JOINING);

    // Повтор той же команды после успеха отвечает тем же входом и никого больше не выводит.
    var request = new Join(UUID.randomUUID(), invite(third), "Гость");
    var moved = rooms.join(third.roomId(), request, leaving(second.roomId()));
    assertThat(rooms.join(third.roomId(), request, leaving(second.roomId()))).isEqualTo(moved);
    assertThat(member(entered).status).isEqualTo(RoomState.Status.LEFT);
  }

  /**
   * Две вкладки одного профиля входят одновременно в две разные встречи — войдёт одна. И два «выйти
   * оттуда и войти сюда» наперегонки тоже не оставляют профиль в двух встречах: второй получает
   * отказ уже с той встречей, куда вошёл первый.
   */
  @Test
  void racingTabsEndUpInOneMeeting() throws Exception {
    var a = someoneElses("А");
    var b = someoneElses("Б");
    var outcomes = race(() -> join(a, ME), () -> join(b, ME));
    assertThat(outcomes).containsExactlyInAnyOrder("entered", "ALREADY_IN_MEETING");
    assertThat(live()).hasSize(1);

    var home = live().getFirst();
    var c = someoneElses("В");
    var d = someoneElses("Г");
    outcomes = race(() -> join(c, leaving(home)), () -> join(d, leaving(home)));
    assertThat(outcomes).containsExactlyInAnyOrder("entered", "ALREADY_IN_MEETING");
    assertThat(live()).hasSize(1).doesNotContain(home);
  }

  private List<String> race(Callable<Admission> one, Callable<Admission> two) throws Exception {
    var start = new CountDownLatch(1);
    try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
      var work =
          List.of(one, two).stream()
              .map(
                  entry ->
                      pool.submit(
                          () -> {
                            start.await();
                            try {
                              entry.call();
                              return "entered";
                            } catch (Problem problem) {
                              return problem.code();
                            }
                          }))
              .toList();
      start.countDown();
      var outcomes = new ArrayList<String>();
      for (var result : work) outcomes.add(result.get());
      return outcomes;
    }
  }

  /** Комнаты, где у профиля сейчас живое участие. */
  private List<String> live() {
    return jdbc.sql("SELECT id FROM rooms").query(String.class).list().stream()
        .map(rooms::read)
        .filter(
            r ->
                r.members.values().stream()
                    .anyMatch(
                        m -> ME.profileHash().equals(r.profiles.get(m.id)) && m.occupiesSeat()))
        .map(r -> r.id)
        .toList();
  }

  /**
   * Восстановление связи — то же участие, а не второе; ожидание у двери — тоже участие; ушедший,
   * исключённый и истёкший — уже нет.
   */
  @Test
  void recoveryIsTheSameParticipationAndAnEndedOneIsNot() {
    var first = create("Первая", ME);
    media.observe(first.roomId(), Map.of(first.participantId(), "PA_1"), now.incrementAndGet());
    command(first, "media.lost", member(first).generation);
    assertThat(member(first).status).isEqualTo(RoomState.Status.RECOVERING);
    var other = someoneElses("Другая");
    refusedFor(() -> join(other, ME), first);

    // Вернуться в ту же встречу после обрыва — можно: это она же.
    var back =
        rooms.rejoin(
            first.roomId(), first.credential(), new Rejoin(UUID.randomUUID(), "Хозяин"), ME);
    assertThat(profile(back)).isEqualTo(ME.profileHash());

    // Срок восстановления вышел, а уборка ещё не прошла — участия уже нет.
    media.observe(back.roomId(), Map.of(back.participantId(), "PA_2"), now.incrementAndGet());
    command(back, "media.lost", member(back).generation);
    now.addAndGet(config.recoverySeconds() * 1000L + 1);
    var inOther = join(other, ME);
    assertThat(inOther.roomId()).isEqualTo(other.roomId());

    // Ожидающий у двери — уже во встрече.
    command(inOther, "leave", 0);
    var door = rooms.create(new Create(UUID.randomUUID(), "С дверью", "Хозяин", true));
    var waiting = join(door, ME);
    assertThat(member(waiting).status).isEqualTo(RoomState.Status.WAITING);
    var third = someoneElses("Третья");
    refusedFor(() -> join(third, ME), door);

    // Исключённый ведущим — свободен.
    rooms.command(
        door.roomId(),
        door.credential(),
        new Command(UUID.randomUUID(), "participant.remove", null, waiting.participantId(), 0));
    assertThat(join(third, ME).roomId()).isEqualTo(third.roomId());
  }

  /** Боты — не люди: музыка правилом не затрагивается и ничьей встречей не считается. */
  @Test
  void theMusicBotIsNobodysMeeting() {
    var first = create("Первая", ME);
    var music = rooms.addMusicService(first.roomId(), UUID.randomUUID());
    assertThat(profile(music)).isNull();
    var other = someoneElses("Другая");
    rooms.addMusicService(other.roomId(), UUID.randomUUID());
    refusedFor(() -> join(other, ME), first);
  }

  // T06: двадцать человек, боты не в счёт ------------------------------------------------------

  @Test
  void twentyPeopleFitAndTheMusicBotDoesNotTakeASeat() {
    assertThat(config.maxParticipants()).isEqualTo(20);
    var host = someoneElses("Большая");
    for (int i = 1; i < config.maxParticipants(); i++) join(host, Entrant.UNKNOWN);
    // Двадцать людей уже внутри, а музыке место находится: бот место не занимает.
    var music = rooms.addMusicService(host.roomId(), UUID.randomUUID());
    assertThat(music.participantId()).isNotBlank();
    assertThatThrownBy(() -> join(host, Entrant.UNKNOWN))
        .isInstanceOfSatisfying(
            Problem.class,
            problem -> {
              assertThat(problem.code()).isEqualTo("ROOM_FULL");
              assertThat(problem.getMessage()).contains("20");
            });
    assertThat(rooms.read(host.roomId()).seatedHumans()).isEqualTo(20);
  }

  /**
   * Комната занимает место на сервере ({@code stream.max-rooms}), когда в ней хотя бы один человек
   * на связи или когда она моложе тридцати секунд: пять POST без подключения больше не держат
   * сервер две минуты (A1 модели угроз).
   */
  @Test
  void aRoomHoldsAServerSlotOnlyWhileSomebodyIsConnectedOrItIsNew() {
    var room = someoneElses("Слот");
    var state = rooms.read(room.roomId());
    long created = state.createdAt;
    assertThat(state.busy(created)).isTrue();
    assertThat(state.busy(created + 29_999)).isTrue();
    assertThat(state.busy(created + 30_000)).isFalse();
    media.observe(room.roomId(), Map.of(room.participantId(), "PA_1"), now.incrementAndGet());
    state = rooms.read(room.roomId());
    assertThat(state.busy(created + 60_000)).isTrue();
    // Бот на связи без людей комнату не держит.
    var lonely = rooms.read(room.roomId());
    lonely.members.values().forEach(m -> m.service = "music");
    assertThat(lonely.busy(created + 60_000)).isFalse();
    command(room, "close", 0);
    assertThat(rooms.read(room.roomId()).busy(created)).isFalse();
  }

  // T06: десять комнат в избранном --------------------------------------------------------------

  @Test
  void aProfileKeepsAtMostTenSavedMeetings() throws Exception {
    assertThat(config.favorites().maxSaved()).isEqualTo(10);
    var hosts =
        java.util.stream.IntStream.range(0, 12).mapToObj(i -> someoneElses("№" + i)).toList();
    var refused = new ArrayList<Problem>();
    try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
      var results =
          hosts.stream()
              .map(h -> pool.submit(() -> favorites.save(SECRET, h.roomId(), h.credential())))
              .toList();
      for (var result : results)
        try {
          result.get();
        } catch (ExecutionException e) {
          refused.add((Problem) e.getCause());
        }
    }
    // Двенадцать одновременных записей: десять сохранены, две получили понятный отказ с числом.
    assertThat(favorites.list(SECRET)).hasSize(10);
    assertThat(refused)
        .hasSize(2)
        .allSatisfy(
            problem -> {
              assertThat(problem.status()).isEqualTo(409);
              assertThat(problem.code()).isEqualTo("FAVORITES_FULL");
              assertThat(problem.properties()).containsEntry("max", 10);
              // Те же слова, что подсказка у звезды на главной (E02).
              assertThat(problem.getMessage())
                  .isEqualTo("В избранном уже 10 комнат. Уберите одну, чтобы добавить эту");
            });
    var kept = favorites.list(SECRET).getFirst().roomId();
    var keptHost = hosts.stream().filter(h -> h.roomId().equals(kept)).findFirst().orElseThrow();
    var outside =
        hosts.stream()
            .filter(
                h -> favorites.list(SECRET).stream().noneMatch(f -> f.roomId().equals(h.roomId())))
            .findFirst()
            .orElseThrow();
    // Уже сохранённое сохраняется повторно без отказа: это не одиннадцатая комната.
    favorites.save(SECRET, kept, keptHost.credential());
    // Убрал одну — одиннадцатая встаёт на её место.
    favorites.remove(SECRET, kept);
    favorites.save(SECRET, outside.roomId(), outside.credential());
    assertThat(favorites.list(SECRET)).hasSize(10);
    // У другого профиля свой счёт.
    favorites.save("O".repeat(43), kept, keptHost.credential());
  }

  /** Сохранённое сверх предела раньше не удаляется, но новое не добавляется (П3). */
  @Test
  void favoritesBeyondTheLimitSurviveButNothingNewIsAdded() {
    var hash = Identity.profileHash(SECRET);
    for (int i = 0; i < 11; i++) {
      var host = someoneElses("Старое №" + i);
      jdbc.sql(
              "INSERT INTO favorites(profile_hash,room_id,member_id,saved_at,sort_order) VALUES(?,?,?,?,?)")
          .params(hash, host.roomId(), host.participantId(), now.get(), i)
          .update();
    }
    assertThat(favorites.list(SECRET)).hasSize(11);
    var fresh = someoneElses("Новое");
    assertThatThrownBy(() -> favorites.save(SECRET, fresh.roomId(), fresh.credential()))
        .isInstanceOf(Problem.class)
        .extracting("code")
        .isEqualTo("FAVORITES_FULL");
    assertThat(favorites.list(SECRET)).hasSize(11);
  }

  // T35: время встречи ------------------------------------------------------------------------

  /**
   * Встреча началась, когда в ней впервые двое живых людей на связи. Бот на связи — не второй
   * человек; ожидание входа — ещё не связь. Метка ставится один раз и не сдвигается; повторное
   * открытие сохранённой встречи начинает её заново.
   */
  @Test
  void theMeetingClockStartsWhenTheSecondPersonIsOnTheLine() {
    var host = create("Часы", ME);
    var guest = join(host, Entrant.UNKNOWN);
    assertThat(rooms.read(host.roomId()).startedAt).isNull();
    assertThat(Json.write(rooms.read(host.roomId()))).doesNotContain("startedAt");

    media.observe(host.roomId(), Map.of(host.participantId(), "PA_h"), now.incrementAndGet());
    var music = rooms.addMusicService(host.roomId(), UUID.randomUUID());
    media.webhook(
        host.roomId(), music.participantId(), "PA_m", "participant_joined", now.incrementAndGet());
    assertThat(rooms.read(host.roomId()).startedAt).isNull();
    assertThat(rooms.snapshot(host.roomId(), host.credential()).startedAt()).isNull();

    long second = now.addAndGet(5000);
    command(guest, "media.restored", member(guest).generation);
    assertThat(rooms.read(host.roomId()).startedAt).isEqualTo(second);
    assertThat(rooms.snapshot(host.roomId(), guest.credential()).startedAt()).isEqualTo(second);

    // Ушёл и вернулся второй человек — встреча не начинается заново.
    command(guest, "leave", 0);
    now.addAndGet(60_000);
    var again = join(host, Entrant.UNKNOWN);
    media.webhook(
        host.roomId(), again.participantId(), "PA_g", "participant_joined", now.incrementAndGet());
    assertThat(rooms.read(host.roomId()).startedAt).isEqualTo(second);

    // Завершили, открыли снова из избранного — новая встреча, новый отсчёт.
    favorites.save(SECRET, host.roomId(), host.credential());
    command(host, "close", 0);
    var reopened =
        favorites.join(SECRET, host.roomId(), new Rejoin(UUID.randomUUID(), "Хозяин"), ME);
    assertThat(reopened.snapshot().startedAt()).isNull();
    assertThat(rooms.read(host.roomId()).startedAt).isNull();
  }

  /** Встреча, где двое уже были на связи до выкатки, получает метку на ближайшем проходе SFU. */
  @Test
  void aMeetingInProgressGetsItsClockOnTheNextSfuPass() {
    var host = someoneElses("Идёт");
    var guest = join(host, Entrant.UNKNOWN);
    media.observe(
        host.roomId(),
        Map.of(host.participantId(), "PA_h", guest.participantId(), "PA_g"),
        now.incrementAndGet());
    assertThat(rooms.read(host.roomId()).startedAt).isEqualTo(now.get());
  }

  // Профиль устройства --------------------------------------------------------------------------

  /** Профиль хранится хэшем и наружу не уходит никогда — ни в снимке, ни в списке участников. */
  @Test
  void theProfileNeverLeavesTheCore() {
    var host = create("Тайна", ME);
    assertThat(profile(host)).isEqualTo(ME.profileHash()).isNotEqualTo(SECRET);
    var snapshot = Json.write(rooms.snapshot(host.roomId(), host.credential()));
    assertThat(snapshot).doesNotContain(ME.profileHash()).doesNotContain("profiles");
    assertThat(Json.write(host)).doesNotContain(ME.profileHash());
  }

  @Test
  void identityReadsTheProfileAndTheMeetingToLeaveFromHeaders() {
    var identity = new Identity();
    var request = new MockHttpServletRequest();
    assertThat(identity.entrant(request)).isEqualTo(Entrant.UNKNOWN);

    request.addHeader(Identity.PROFILE, SECRET);
    var room = UUID.randomUUID().toString();
    request.addHeader(Identity.LEAVE, room);
    assertThat(identity.entrant(request)).isEqualTo(new Entrant(ME.profileHash(), room));

    // Не похожее на секрет профиля и на комнату — как будто заголовка нет: правило удобства не
    // должно ломать вход старому или чужому клиенту.
    var odd = new MockHttpServletRequest();
    odd.addHeader(Identity.PROFILE, "short");
    odd.addHeader(Identity.LEAVE, "../rooms");
    assertThat(identity.entrant(odd)).isEqualTo(Entrant.UNKNOWN);
    assertThat(Identity.profileHash("Bearer " + SECRET)).isNull();
  }
}
