package dev.mikki.stream.access;

/**
 * Кто входит во встречу — то, что ядро знает о нём помимо тела запроса.
 *
 * <p>{@code profileHash} — профиль устройства, хэш секрета из {@code X-Cord-Profile} ({@link
 * Identity}). У старого клиента и у служб его нет, и тогда правило одной встречи на профиль (T52) к
 * ним не применяется: это удобство, а не защита (П13).
 *
 * <p>{@code leave} — встреча из {@code X-Cord-Leave}: человек увидел «Вы уже во встрече…» и ответил
 * «Выйти оттуда и войти сюда». Ядро закрывает прежнее участие и пускает в том же запросе — или не
 * делает ни того, ни другого.
 *
 * <p>{@code address} — ключ пределов антибота (E11): IPv4, сеть /64 или актор службы ({@code
 * ClientAddress}). У внутренних вызовов служб без актора и у тестов его нет — тогда пределы на
 * адрес к ним не применяются.
 */
public record Entrant(String profileHash, String leave, String address) {
  /** Вход без профиля и адреса: служба, тест. */
  public static final Entrant UNKNOWN = new Entrant(null, null, null);

  public Entrant(String profileHash, String leave) {
    this(profileHash, leave, null);
  }

  /** Тот же входящий, пришедший с этого адреса. */
  public Entrant from(String address) {
    return new Entrant(profileHash, leave, address);
  }
}
