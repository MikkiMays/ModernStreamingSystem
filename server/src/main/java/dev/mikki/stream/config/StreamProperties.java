package dev.mikki.stream.config;

import jakarta.validation.constraints.*;
import java.nio.file.Path;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties("stream")
public record StreamProperties(
    @NotBlank String publicUrl,
    @NotBlank String livekitUrl,
    @NotBlank String livekitInternalUrl,
    @NotBlank String tusdInternalUrl,
    @NotBlank String livekitKey,
    @NotBlank @Size(min = 32) String livekitSecret,
    @NotBlank @Size(min = 32) String sessionSecret,
    @NotBlank @Size(min = 32) String internalSecret,
    @NotNull Path filesRoot,
    boolean redisEnabled,
    @Min(1) @Max(10) int maxParticipants,
    @Min(1) @Max(2) int maxScreens,
    @Min(1) int maxRooms,
    @Min(5) @Max(60) int recoverySeconds,
    @Min(20) @Max(300) int joinSeconds,
    @Min(20) int emptyRoomSeconds,
    @Min(60) int unusedRoomSeconds,
    @Min(60) @Max(86400) int retentionSeconds,
    @Min(60) @Max(3600) int closedRetentionSeconds,
    @Min(60) @Max(3600) int uploadTimeoutSeconds,
    @Min(1) long fileMaxBytes,
    @Min(1) long roomMaxBytes,
    @Min(1) long totalMaxBytes,
    @Min(10) @Max(10000) int eventHistoryLimit,
    boolean admissionOpen) {
  @AssertTrue(message = "File quota must not exceed room quota, which must not exceed total quota")
  public boolean isQuotaOrderValid() {
    return fileMaxBytes <= roomMaxBytes && roomMaxBytes <= totalMaxBytes;
  }
}
