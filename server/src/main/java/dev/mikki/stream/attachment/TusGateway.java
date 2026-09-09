package dev.mikki.stream.attachment;

import dev.mikki.stream.config.StreamProperties;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import org.springframework.stereotype.Component;

/** Termination takes tusd's upload lock before removing a potentially active PATCH. */
@Component
public class TusGateway {
  private final HttpClient client =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
  private final StreamProperties config;

  public TusGateway(StreamProperties config) {
    this.config = config;
  }

  public boolean terminate(String id) {
    if (!id.matches("[0-9a-f-]{36}")) return false;
    try {
      var request =
          HttpRequest.newBuilder(URI.create(config.tusdInternalUrl() + "/uploads/" + id))
              .timeout(Duration.ofSeconds(5))
              .header("Tus-Resumable", "1.0.0")
              .DELETE()
              .build();
      int status = client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode();
      return status == 204 || status == 404 || status == 410;
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      return false;
    } catch (java.io.IOException e) {
      return false;
    }
  }
}
