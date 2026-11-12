package dev.mikki.stream.activity;

import dev.mikki.stream.access.InternalKeys;
import dev.mikki.stream.access.Secrets;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.shared.Json;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.annotation.PreDestroy;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.LongAdder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Факты ядра для службы аналитики {@code insight} (R239, {@code contracts/insight.md} §2, {@code
 * docs/architecture/analytics-v2.md}): что случилось на самом деле — вход, связь, встреча,
 * качество, интеграция, отказ защиты. Ядро больше ничего не считает само: прежняя аналитика
 * (посетители по профилям) удалена вместе с таблицами (Р-136), счёт ведёт служба.
 *
 * <p>БУФЕР. Факт ложится в память — не больше {@link #BUFFER_LIMIT} штук и {@link #BUFFER_BYTES}
 * знаков — и раз в {@link #FLUSH_MS} уходит службе пачкой не больше {@link #BATCH}: {@code POST
 * /internal/facts} с ключом назначения {@code insight} в {@code X-Insight-Key}. Служба молчит или
 * отказала — та же пачка с теми же {@code id} уйдёт следующим проходом: повтор у службы ничего не
 * удваивает. Буфер полон — выбрасываются самые старые, со строкой в журнале и счётчиком.
 *
 * <p>ВСТРЕЧА ОТ АНАЛИТИКИ НЕ ЗАВИСИТ. {@link #publish} — только запись в память: ни сети, ни базы,
 * ни ожидания. В транзакции комнаты факт не публикуется вовсе — после её фиксации ({@link
 * #afterCommit}): откатившаяся встреча следов не оставляет, а отказ аналитики не становится отказом
 * человеку. Отправка идёт своим проходом по расписанию ({@link InsightSchedule}) с короткими
 * сроками — подключение {@link #CONNECT_TIMEOUT}, ответ {@link #READ_TIMEOUT}.
 *
 * <p>ВЫКЛЮЧЕНО — НИЧЕГО НЕ СТОИТ. Адрес службы пуст ({@code stream.insight.url}, {@code
 * INSIGHT_URL}) — {@link #enabled} ложь: факты не собираются, наблюдатель комнат выходит первой
 * строкой, проходы расписания пусты.
 *
 * <p>ЛИЧНОСТЬ. В фактах — псевдоним профиля ({@link #pseudonym}): HMAC секретом сервера от {@code
 * "analytics:" + хэш профиля} — та же формула, по которой служба узнаёт профиль из событий клиента
 * ({@code contracts/insight.md} §4). Ни секрета профиля, ни его хэша, ни адреса в фактах нет.
 */
@Component
public class InsightFacts {
  private static final Logger log = LoggerFactory.getLogger(InsightFacts.class);

  /** Сколько фактов держит буфер; сверх — старые выбрасываются. */
  public static final int BUFFER_LIMIT = 100_000;

  /**
   * Сколько знаков держит буфер: сто тысяч тиков присутствия полных встреч — это сотни мегабайт.
   */
  public static final long BUFFER_BYTES = 64L * 1024 * 1024;

  /** Фактов в одной пачке. */
  public static final int BATCH = 500;

  /** Знаков в одной пачке: служба не принимает больше 2 МиБ. */
  static final int BATCH_BYTES = 1_500_000;

  /** Как часто буфер уходит службе, мс. */
  public static final long FLUSH_MS = 2_000;

  /**
   * Пачек за один проход: служба легла и встала — буфер уходит за несколько проходов, не за один.
   */
  static final int BATCHES_PER_PASS = 20;

  public static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(2);
  public static final Duration READ_TIMEOUT = Duration.ofSeconds(5);

  /** Заголовок с ключом назначения {@link #PURPOSE} ({@code contracts/headers.md}). */
  public static final String KEY_HEADER = "X-Insight-Key";

  /** Назначение ключа HKDF из {@code INTERNAL_SECRET} — как у {@link InternalKeys}. */
  public static final String PURPOSE = "insight";

  /** Сколько псевдонимов профилей помнить: HMAC один раз на профиль, а не на каждый факт. */
  static final int PSEUDONYMS = 50_000;

  /** Отправка пачки службе: тело — JSON, ответ — статус. */
  @FunctionalInterface
  public interface Transport {
    int post(String body) throws Exception;
  }

  private final boolean enabled;
  private final Transport transport;
  private final Secrets secrets;
  private final Clock clock;

  /** Очередь и пачка в полёте — под этим замком; держится мгновения, сети под ним нет. */
  private final Object lock = new Object();

  /** Проход отправки — один за раз: расписание и остановка ядра не шлют одну пачку вдвоём. */
  private final Object sending = new Object();

  private final ArrayDeque<String> queue = new ArrayDeque<>();
  private List<String> inflight;
  private long bytes;
  private long droppedTotal;

  private final LinkedHashMap<String, String> pseudonyms =
      new LinkedHashMap<>(1024, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, String> eldest) {
          return size() > PSEUDONYMS;
        }
      };

  /** Отказы защиты с прошлой минуты: код → сколько. Кодов столько, сколько их в реестре ошибок. */
  private final Map<String, LongAdder> refusals = new ConcurrentHashMap<>();

  private final Counter sent;
  private final Counter failed;
  private final Counter dropped;

  @Autowired
  public InsightFacts(
      InsightProperties insight,
      StreamProperties config,
      Secrets secrets,
      Clock clock,
      ObjectProvider<MeterRegistry> registry) {
    this(
        insight.on()
            ? http(
                insight.base() + "/internal/facts",
                InternalKeys.derive(config.internalSecret(), PURPOSE))
            : null,
        secrets,
        clock,
        registry.getIfAvailable());
  }

  /** Со своей отправкой — для тестов; {@code transport == null} — выключено. */
  public InsightFacts(Transport transport, Secrets secrets, Clock clock, MeterRegistry registry) {
    this.enabled = transport != null;
    this.transport = transport;
    this.secrets = secrets;
    this.clock = clock;
    sent = counter(registry, "cord.insight.facts.sent", "Факты, принятые службой аналитики");
    failed =
        counter(
            registry,
            "cord.insight.facts.failed",
            "Проходы отправки фактов, на которые служба аналитики не ответила или отказала");
    dropped =
        counter(
            registry,
            "cord.insight.facts.dropped",
            "Факты, выброшенные из буфера: он полон или пачку служба не приняла вовсе");
    if (registry != null && enabled)
      Gauge.builder("cord.insight.facts.buffered", this, InsightFacts::buffered)
          .description("Факты в буфере ядра, ещё не принятые службой аналитики")
          .register(registry);
  }

  private static Counter counter(MeterRegistry registry, String name, String description) {
    return registry == null
        ? null
        : Counter.builder(name).description(description).register(registry);
  }

  private static void add(Counter counter, double amount) {
    if (counter != null && amount > 0) counter.increment(amount);
  }

  private static Transport http(String url, String key) {
    var client =
        HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(CONNECT_TIMEOUT)
            .build();
    var target = URI.create(url);
    return body ->
        client
            .send(
                HttpRequest.newBuilder(target)
                    .timeout(READ_TIMEOUT)
                    .header("Content-Type", "application/json")
                    .header(KEY_HEADER, key)
                    .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                    .build(),
                HttpResponse.BodyHandlers.discarding())
            .statusCode();
  }

  /** Собираются ли факты: задан адрес службы. */
  public boolean enabled() {
    return enabled;
  }

  // ── Факт ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * Один факт: свой {@code id}, момент по часам ядра, тип из {@code contracts/insight.md} §2 и
   * поля. Незаполненное поле ({@code null}) в факт не идёт; {@code profile} — исключение: «профиля
   * нет» контракт пишет явным {@code null}.
   */
  public final class Fact {
    private final LinkedHashMap<String, Object> fields = new LinkedHashMap<>();

    private Fact(String type, long at) {
      fields.put("id", UUID.randomUUID().toString());
      fields.put("at", at);
      fields.put("type", type);
    }

    public Fact put(String name, Object value) {
      if (value != null) fields.put(name, value);
      return this;
    }

    /**
     * Номер факта — из того, что его определяет, а не случайный: одно и то же событие, рассказанное
     * дважды (повтор принятого входа после обрыва связи), служба примет один раз.
     */
    public Fact once(String what) {
      fields.put(
          "id",
          UUID.nameUUIDFromBytes((fields.get("type") + ":" + what).getBytes(StandardCharsets.UTF_8))
              .toString());
      return this;
    }

    /** Псевдоним профиля по его хэшу; профиля нет — {@code null}. */
    public Fact profile(String profileHash) {
      fields.put("profile", pseudonym(profileHash));
      return this;
    }

    /** В буфер. Вызывать вне транзакции комнаты — см. {@link InsightFacts#afterCommit}. */
    public void publish() {
      InsightFacts.this.publish(fields);
    }
  }

  /** Новый факт с моментом «сейчас». */
  public Fact fact(String type) {
    return new Fact(type, clock.millis());
  }

  /** Новый факт с моментом события. */
  public Fact fact(String type, long at) {
    return new Fact(type, at);
  }

  /**
   * Псевдоним профиля для аналитики: {@code base64url(HMAC-SHA256(SESSION_SECRET, "analytics:" +
   * хэш профиля))} — {@code contracts/insight.md} §4. Профиля нет — {@code null}.
   */
  public String pseudonym(String profileHash) {
    if (profileHash == null) return null;
    synchronized (pseudonyms) {
      var known = pseudonyms.get(profileHash);
      if (known != null) return known;
    }
    var derived = secrets.derive("analytics:" + profileHash);
    synchronized (pseudonyms) {
      pseudonyms.put(profileHash, derived);
    }
    return derived;
  }

  private void publish(Map<String, Object> fields) {
    if (!enabled) return;
    String json;
    try {
      json = Json.write(fields);
    } catch (RuntimeException e) {
      log.warn("Аналитика: факт не собран: {}", e.toString());
      return;
    }
    int lost = 0;
    synchronized (lock) {
      queue.addLast(json);
      bytes += json.length();
      // Сверх предела уходят старейшие; пачка в полёте не трогается — её повтор должен быть той же.
      while (!queue.isEmpty() && (buffered() > BUFFER_LIMIT || bytes > BUFFER_BYTES)) {
        bytes -= queue.pollFirst().length();
        lost++;
      }
      if (lost > 0) {
        long before = droppedTotal;
        droppedTotal += lost;
        // Первая потеря и дальше раз в десять тысяч: буфер полон минутами, строк — единицы.
        if (before == 0 || before / 10_000 != droppedTotal / 10_000)
          log.warn(
              "Аналитика: буфер фактов полон ({} шт.), старые выбрасываются; всего выброшено {}",
              buffered(),
              droppedTotal);
      }
    }
    add(dropped, lost);
  }

  /** Сколько фактов ждут службу: очередь и пачка в полёте. */
  public int buffered() {
    synchronized (lock) {
      return queue.size() + (inflight == null ? 0 : inflight.size());
    }
  }

  /**
   * Факт {@code quality} из десятисекундной сводки клиента ({@link RxQuality.RxSummary}): секунды
   * своей камеры и показа за окно и байты вверх и вниз. Чего в сводке нет — секунд микрофона,
   * потерь, оборота, замираний, пути через TURN, переподключений, — того нет и в факте: служба
   * читает отсутствующее поле как ноль.
   */
  public void quality(String roomId, String profileHash, RxQuality.RxSummary summary) {
    if (!enabled) return;
    double camera = 0, screen = 0;
    if (summary.tx() != null)
      for (var tx : summary.tx()) {
        if ("camera".equals(tx.source())) camera += tx.seconds();
        else screen += tx.seconds();
      }
    fact("quality")
        .put("room", roomId)
        .profile(profileHash)
        .put("cam_s", Math.round(camera * 10) / 10.0)
        .put("screen_s", Math.round(screen * 10) / 10.0)
        .put("bytes_up", summary.bytesUp())
        .put("bytes_down", summary.bytesDown())
        .publish();
  }

  // ── Отказы защиты ────────────────────────────────────────────────────────────────────────────

  /** Отказ защиты ли это: любой предел ({@code 429}), блок или не пройденная задача «не робот». */
  public static boolean guard(String code, int status) {
    return status == 429 || "BLOCKED".equals(code) || "PROOF_INVALID".equals(code);
  }

  /**
   * Ядро отказало с этим кодом. Отказы защиты ({@link #guard}) копятся счётчиком на код и уходят
   * итогом минуты ({@link #refusals}): поток отказов скрипту не становится потоком фактов.
   */
  public void refused(String code, int status) {
    if (!enabled || code == null || !guard(code, status)) return;
    refusals.computeIfAbsent(code, c -> new LongAdder()).increment();
  }

  /** Итог минуты: по факту {@code refusal} на каждый код, по которому были отказы. */
  public void refusals() {
    if (!enabled) return;
    for (var entry : refusals.entrySet()) {
      long count = entry.getValue().sumThenReset();
      if (count > 0) fact("refusal").put("code", entry.getKey()).put("count", count).publish();
    }
  }

  // ── Отправка ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Отправить буфер: пачка за пачкой, пока служба принимает, но не больше {@link #BATCHES_PER_PASS}
   * за проход. Отказ или молчание останавливают проход — та же пачка уйдёт следующим. Пачку,
   * которую служба не примет никогда ({@code 400}, {@code 413}), повторять незачем: она
   * выбрасывается со строкой в журнале. Сколько фактов принято.
   */
  public int flush() {
    if (!enabled) return 0;
    synchronized (sending) {
      int accepted = 0;
      for (int pass = 0; pass < BATCHES_PER_PASS; pass++) {
        List<String> batch;
        synchronized (lock) {
          if (inflight == null) inflight = take();
          batch = inflight;
        }
        if (batch == null) break;
        int status;
        try {
          status = transport.post(body(batch));
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
          break;
        } catch (Exception e) {
          failure(e.getClass().getSimpleName());
          break;
        }
        if (status >= 200 && status < 300) {
          done(batch);
          add(sent, batch.size());
          accepted += batch.size();
        } else if (status == 400 || status == 413) {
          done(batch);
          add(dropped, batch.size());
          log.warn(
              "Аналитика: служба не приняла пачку из {} фактов ({}), пачка выброшена",
              batch.size(),
              status);
        } else {
          failure("HTTP " + status);
          break;
        }
      }
      return accepted;
    }
  }

  /** Следующая пачка из очереди; под {@link #lock}. Пусто — {@code null}. */
  private List<String> take() {
    if (queue.isEmpty()) return null;
    var batch = new ArrayList<String>(Math.min(BATCH, queue.size()));
    int size = 0;
    while (!queue.isEmpty() && batch.size() < BATCH) {
      var next = queue.peekFirst();
      if (!batch.isEmpty() && size + next.length() > BATCH_BYTES) break;
      batch.add(queue.pollFirst());
      size += next.length();
    }
    return batch;
  }

  private void done(List<String> batch) {
    synchronized (lock) {
      if (inflight == batch) inflight = null;
      for (var fact : batch) bytes -= fact.length();
    }
  }

  private long failureLoggedAt = Long.MIN_VALUE;

  /** Служба не ответила: счётчик и строка в журнале не чаще раза в минуту. */
  private void failure(String reason) {
    add(failed, 1);
    long now = clock.millis();
    if (failureLoggedAt != Long.MIN_VALUE
        && now - failureLoggedAt < 60_000
        && now >= failureLoggedAt) return;
    failureLoggedAt = now;
    log.warn(
        "Аналитика: служба не приняла факты ({}), в буфере {} — повтор следующим проходом",
        reason,
        buffered());
  }

  private static String body(List<String> batch) {
    int size = 32;
    for (var fact : batch) size += fact.length() + 1;
    var body = new StringBuilder(size).append("{\"source\":\"core\",\"facts\":[");
    for (int i = 0; i < batch.size(); i++) {
      if (i > 0) body.append(',');
      body.append(batch.get(i));
    }
    return body.append("]}").toString();
  }

  /** Остановка ядра: один проход отправки — что служба примет сразу, то и ушло. */
  @PreDestroy
  public void shutdown() {
    try {
      flush();
    } catch (RuntimeException e) {
      log.warn("Аналитика: буфер фактов при остановке не отправлен: {}", e.toString());
    }
  }

  /**
   * Выполнить после фиксации транзакции комнаты; без транзакции — сразу. Отказ здесь не доходит до
   * того, кто менял комнату: встреча уже зафиксирована, и ответ человеку не должен стать ошибкой.
   */
  public static void afterCommit(Runnable action) {
    Runnable safe =
        () -> {
          try {
            action.run();
          } catch (RuntimeException e) {
            log.warn("Аналитика: факт о встрече не собран: {}", e.toString());
          }
        };
    if (TransactionSynchronizationManager.isSynchronizationActive())
      TransactionSynchronizationManager.registerSynchronization(
          new TransactionSynchronization() {
            @Override
            public void afterCommit() {
              safe.run();
            }
          });
    else safe.run();
  }
}
