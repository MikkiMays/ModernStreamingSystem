-- «Сообщить о проблеме» (R79): что не так во встрече — словами через запятую (`sound,music`), по
-- порядку списка `SupportService.ISSUES`. У обычного обращения — NULL.
ALTER TABLE support_tickets ADD COLUMN issues VARCHAR(200);
