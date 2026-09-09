package dev.mikki.stream;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import dev.mikki.stream.api.InternalController;
import dev.mikki.stream.attachment.AttachmentService;
import dev.mikki.stream.config.StreamProperties;
import dev.mikki.stream.media.MediaService;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class SignalingGateTest {
  @Test
  void clientHeadersCannotSubstituteTheActualSignalingToken() throws Exception {
    var media = mock(MediaService.class);
    var config = mock(StreamProperties.class);
    when(config.livekitKey()).thenReturn("testkey");
    when(config.livekitSecret()).thenReturn("a-test-secret-with-at-least-32-characters");
    var mvc =
        MockMvcBuilders.standaloneSetup(
                new InternalController(media, mock(AttachmentService.class), config))
            .build();

    mvc.perform(
            get("/internal/signaling-auth")
                .header("X-Media-Token", "actual-signaling-token")
                .header("X-Original-Uri", "/rtc?access_token=unrelated-valid-token")
                .header("Authorization", "Bearer another-token"))
        .andExpect(status().isOk());

    verify(media).authorizeSignaling("actual-signaling-token");
    verifyNoMoreInteractions(media);
  }
}
