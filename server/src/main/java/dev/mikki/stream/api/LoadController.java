package dev.mikki.stream.api;

import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.activity.LoadMeter;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.nodes.MediaNodes;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Загрузка сервера палочками рядом с пингом (R143, Р-37) и ступень каждого медиаузла для списка
 * «Настройки → Сервер» (R200). Открыто, как {@code /ping}: в ответах только ступень 1–4 и
 * состояние, без чисел встреч и людей.
 */
@RestController
@RequestMapping("/api/v1")
public class LoadController {
  /**
   * Узел для списка в настройках: флаг по {@code country}, город по {@code title}, палочки по
   * {@code level}. {@code state}: ok, busy, full, down, drained — серый узел, на него встречу не
   * поставить.
   */
  public record NodeLoad(
      String id,
      Map<String, String> title,
      @com.fasterxml.jackson.annotation.JsonInclude(
              com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
          String country,
      boolean control,
      int level,
      String state) {}

  private final LoadMeter meter;
  private final StreamProperties config;
  private final RateLimits limits;
  private final ClientAddress address;
  private final MediaNodes nodes;

  public LoadController(
      LoadMeter meter,
      StreamProperties config,
      RateLimits limits,
      ClientAddress address,
      MediaNodes nodes) {
    this.meter = meter;
    this.config = config;
    this.limits = limits;
    this.address = address;
    this.nodes = nodes;
  }

  /** Ступень этого сервера; меняется не чаще замера раз в 5 с — столько её и можно кешировать. */
  @GetMapping("/load")
  public ResponseEntity<LoadMeter.Load> load(HttpServletRequest http) {
    limits.address("load:" + address.of(http), 120);
    return ResponseEntity.ok()
        .cacheControl(CacheControl.maxAge(5, TimeUnit.SECONDS).cachePublic())
        .body(meter.current());
  }

  /**
   * Все узлы реестра со ступенью и состоянием, узел управления — первым. Мёртвые и дренируемые тоже
   * в списке — серыми: человек видит, почему узла нельзя выбрать, а не гадает, куда он пропал.
   */
  @GetMapping("/nodes")
  public ResponseEntity<List<NodeLoad>> nodes(HttpServletRequest http) {
    limits.address("load:" + address.of(http), 120);
    var list =
        nodes.all().stream()
            .map(
                n -> {
                  var level = nodes.levelOf(n);
                  return new NodeLoad(
                      n.id(), n.title(), n.country(), n.control(), level.level(), level.state());
                })
            .toList();
    return ResponseEntity.ok()
        .cacheControl(CacheControl.maxAge(5, TimeUnit.SECONDS).cachePublic())
        .body(list);
  }
}
