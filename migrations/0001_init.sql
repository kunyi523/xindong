-- 今天，怎么心动？ · 评分库
--
-- 一条记录 = 一对情侣对一个地点的一次评分。
-- 没有账号表，没有用户表：by_id 是设备上随机生成的一串字符，用来做去重和限流。
-- 存的东西刻意很少——地点标识、分数、几个布尔维度、标签、一句话、MBTI 组合。
-- 没有位置、没有姓名、没有联系方式。

CREATE TABLE IF NOT EXISTS reviews (
  pid     TEXT    NOT NULL,          -- 地点标识：osm:node/123 或 act:火锅暖场
  name    TEXT    NOT NULL DEFAULT '',
  r       INTEGER NOT NULL,          -- 总体 1–5
  dims    TEXT    NOT NULL DEFAULT '{}',  -- {quiet,pair,linger,photo,noqueue} 各 0/1
  tags    TEXT    NOT NULL DEFAULT '[]',  -- 适合：第一次约会 / 纪念日 / …
  cost    TEXT    NOT NULL DEFAULT '',    -- 穷开心 / 小奢侈 / 豪华版
  txt     TEXT    NOT NULL DEFAULT '',    -- 想说的一句话，最多 60 字
  mbti    TEXT    NOT NULL DEFAULT '',    -- 两人类型，排序后用 - 连接，如 ENFP-ISFJ
  by_id   TEXT    NOT NULL,          -- 设备随机 id
  at      INTEGER NOT NULL,          -- 毫秒时间戳
  hidden  INTEGER NOT NULL DEFAULT 0,-- 人工下架用：置 1 就不再参与合并
  PRIMARY KEY (pid, by_id)           -- 同一台设备对同一个地点只留最新一条
);

-- 两个人共一张足迹地图。
--
-- 不做账号：一对情侣共用一个不可枚举的 couple id，存在各自设置里、跟着分享链接走。
-- 每台设备把"自己打过的卡"整份存成一行 JSON（而不是一条条增量），所以同步是幂等的：
-- 重传一次结果一样，断在中间也不会留下半份数据。
-- 照片只存缩略图，原图永远留在本机。
CREATE TABLE IF NOT EXISTS couple_state (
  couple TEXT    NOT NULL,       -- c + 16~40 位随机字符
  by_id  TEXT    NOT NULL,       -- 设备随机 id
  at     INTEGER NOT NULL,
  data   TEXT    NOT NULL,       -- {"pins":[{sig,i,ymd,title,at,lat,lon,thumb}]}
  PRIMARY KEY (couple, by_id)
);
CREATE INDEX IF NOT EXISTS idx_couple ON couple_state (couple, at);

-- 限流用的击打记录。只存 IP 的哈希（存原始 IP 等于存了位置），
-- 而且每次写入前先把一小时以前的删掉，所以这张表永远是很小的一张临时表。
CREATE TABLE IF NOT EXISTS hits (
  ip TEXT    NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hits ON hits (ip, at);

CREATE INDEX IF NOT EXISTS idx_reviews_pid  ON reviews (pid, hidden);
CREATE INDEX IF NOT EXISTS idx_reviews_by   ON reviews (by_id, at);
CREATE INDEX IF NOT EXISTS idx_reviews_at   ON reviews (at);

-- 下架一条不合适的评价：
--   UPDATE reviews SET hidden = 1 WHERE pid = ? AND by_id = ?;
-- 看最近交上来的：
--   SELECT pid, name, r, txt, mbti, datetime(at/1000,'unixepoch','localtime')
--     FROM reviews ORDER BY at DESC LIMIT 50;
