package dev.mikki.stream.access;

import dev.mikki.stream.config.Allowance;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.shared.Problem;
import org.springframework.stereotype.Component;

/**
 * Квота загрузок на адрес (A10 модели угроз, {@code stream.abuse.per-ip.uploads}).
 *
 * <p>Пределы на файл, встречу и сервер уже были, а на адрес — нет: «создать встречу, залить
 * гигабайт, закрыть», повторённое десять раз, занимало всю квоту сервера, и загрузки отказывали
 * всем. Теперь один адрес (IPv4 или сеть /64) держит не больше {@code per-ip.uploads} за срок и не
 * больше пятой части {@code total-max-bytes}, сколько бы ни написали в настройке.
 *
 * <p>Сверка — до резерва, засчитывание — после удачи: отказ квоту не тратит. Наши службы (музыка)
 * адреса человека не имеют и квоты не знают.
 */
@Component
public class UploadQuota {
  private final RateLimits limits;
  private final StreamProperties config;

  public UploadQuota(RateLimits limits, StreamProperties config) {
    this.limits = limits;
    this.config = config;
  }

  /** Квота с потолком в пятую часть общего места. */
  public Allowance quota() {
    var configured = config.abuse().perIp().uploads();
    return new Allowance(
        Math.min(configured.bytes(), Math.max(1, config.totalMaxBytes() / 5)), configured.period());
  }

  /** Отказ {@code 413 UPLOAD_QUOTA_IP}, если этот файл в квоту адреса уже не входит. */
  public void check(String addressKey, long bytes) {
    if (addressKey != null && !limits.fits("uploads:" + addressKey, quota(), bytes))
      throw new Problem(
          413,
          "UPLOAD_QUOTA_IP",
          "С этого адреса загружено слишком много файлов. Попробуйте позже");
  }

  public void count(String addressKey, long bytes) {
    if (addressKey != null) limits.add("uploads:" + addressKey, quota(), bytes);
  }
}
