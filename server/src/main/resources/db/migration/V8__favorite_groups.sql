-- Группы избранного (T40) — свои у каждого профиля, как и само избранное: у двух людей одна и та
-- же комната может лежать в разных группах и под разными именами.
CREATE TABLE favorite_groups (
  profile_hash VARCHAR(64) NOT NULL,
  id VARCHAR(36) NOT NULL,
  title VARCHAR(60) NOT NULL,
  sort_order BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(profile_hash, id)
);

-- Ссылка на группу без внешнего ключа: ключ потребовал бы profile_hash в составе, а группу и так
-- удаляет одна служба, и она же возвращает её комнаты в общий список. Висячую ссылку чтение
-- избранного считает «без группы».
ALTER TABLE favorites ADD COLUMN group_id VARCHAR(36);
ALTER TABLE favorites ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT FALSE;
-- Своё имя комнаты — видно только этому профилю; NULL — показывать название комнаты.
ALTER TABLE favorites ADD COLUMN alias VARCHAR(60);
