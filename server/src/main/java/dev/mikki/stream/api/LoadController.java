package dev.mikki.stream.api;

import dev.mikki.stream.access.RateLimits;
import dev.mikki.stream.activity.LoadMeter;
import dev.mikki.stream.activity.NeighborLoad;
import dev.mikki.stream.config.StreamProperties;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Загрузка сервера палочками рядом с пингом (R143, Р-37). Открыто, как {@code /ping}: в ответе
 * только ступень 1–4 и состояние, без чисел встреч и людей.
 */
@RestController
@RequestMapping("/api/v1")
public class LoadController {
  private final LoadMeter meter;
  private final NeighborLoad neighbors;
  private final StreamProperties config;
  private final RateLimits limits;
  private final ClientAddress address;

  public LoadController(
      LoadMeter meter,
      NeighborLoad neighbors,
      StreamProperties config,
      RateLimits limits,
      ClientAddress address) {
    this.meter = meter;
    this.neighbors = neighbors;
    this.config = config;
    this.limits = limits;
    this.address = address;
  }

  /** Ступень этого сервера; меняется не чаще замера раз в 5 с — столько её и можно кешировать. */
  @GetMapping("/load")
  public ResponseEntity<LoadMeter.Load> load(HttpServletRequest http) {
    limits.check("load:" + address.of(http), 120);
    return ResponseEntity.ok()
        .cacheControl(CacheControl.maxAge(5, TimeUnit.SECONDS).cachePublic())
        .body(meter.current());
  }

  /**
   * Ступени всех серверов каталога — для «Сменить сервер» в браузере (CSP не пускает к соседям).
   */
  @GetMapping("/catalog/load")
  public ResponseEntity<List<NeighborLoad.CatalogLoad>> catalogLoad(HttpServletRequest http) {
    limits.check("catalog-load:" + address.of(http), 30);
    return ResponseEntity.ok()
        .cacheControl(CacheControl.maxAge(15, TimeUnit.SECONDS).cachePublic())
        .body(neighbors.all(config.publicUrl(), meter.current()));
  }
}
