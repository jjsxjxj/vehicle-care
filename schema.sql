-- 车辆保养系统 D1 表结构
-- 所有业务表均带 user_id，多用户数据严格隔离

-- ========== 用户 ==========
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  pass_hash     TEXT NOT NULL,
  pass_salt     TEXT NOT NULL,
  iterations    INTEGER NOT NULL DEFAULT 210000,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  banned        INTEGER NOT NULL DEFAULT 0,
  banned_at     TEXT,
  created_at    TEXT NOT NULL
);

-- ========== 会话 ==========
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

-- ========== 车辆档案 ==========
CREATE TABLE IF NOT EXISTS vehicles (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  nickname       TEXT,
  brand          TEXT,
  series         TEXT,
  model_year     TEXT,
  plate          TEXT,
  vin            TEXT,
  purchase_date  TEXT,
  current_km     INTEGER,
  fuel_consumption REAL,   -- 百公里油耗（L/100km），用于加油时预估里程
  km_updated_at  TEXT,
  raw_json       TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vehicles_user ON vehicles(user_id);

-- ========== 保养/消费记录（一张截图 = 一条记录） ==========
-- kind: maintenance=保养 / fuel=加油 / beauty=汽车美容
-- fuel 专用列：unit_price 油价(元/L)、liters 升数、est_km 这箱油按油耗预估能跑的公里数
CREATE TABLE IF NOT EXISTS records (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  vehicle_id    TEXT,
  kind          TEXT NOT NULL DEFAULT 'maintenance',
  shop          TEXT,
  order_no      TEXT,
  order_time    TEXT,
  total_amount  REAL,
  mileage_km    INTEGER,
  unit_price    REAL,
  liters        REAL,
  est_km        INTEGER,
  partial       INTEGER NOT NULL DEFAULT 0,  -- 加油用：1=这次没加满（不结算里程）
  raw_json      TEXT,
  confirm_token TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_user    ON records(user_id);
CREATE INDEX IF NOT EXISTS idx_records_vehicle ON records(vehicle_id, order_time);

-- ========== 记录明细行 ==========
CREATE TABLE IF NOT EXISTS record_items (
  id              TEXT PRIMARY KEY,
  record_id       TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  item_code       TEXT,
  item_name       TEXT NOT NULL,
  spec            TEXT,
  qty             REAL,
  unit_price      REAL,
  amount          REAL,
  warranty_until  TEXT,
  note            TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_record ON record_items(record_id);
CREATE INDEX IF NOT EXISTS idx_items_user   ON record_items(user_id, item_code);

-- ========== 保养计划（到期提醒的核心） ==========
CREATE TABLE IF NOT EXISTS plans (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  vehicle_id       TEXT,
  item_code        TEXT NOT NULL,
  item_name        TEXT NOT NULL,
  spec             TEXT,
  basis            TEXT NOT NULL,
  last_done_at     TEXT,
  last_km          INTEGER,
  interval_months  INTEGER,
  interval_km      INTEGER,
  next_due_at      TEXT,
  next_due_km      INTEGER,
  source_record_id TEXT,
  status           TEXT NOT NULL DEFAULT 'active',
  note             TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_user    ON plans(user_id, status);
CREATE INDEX IF NOT EXISTS idx_plans_vehicle ON plans(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_plans_due     ON plans(next_due_at);

-- ========== 推送流水（去重用） ==========
CREATE TABLE IF NOT EXISTS push_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  plan_id    TEXT NOT NULL,
  due_key    TEXT NOT NULL,
  channel    TEXT NOT NULL DEFAULT 'bark',
  ok         INTEGER NOT NULL DEFAULT 0,
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_push_log ON push_log(user_id, plan_id, due_key, channel);
CREATE INDEX IF NOT EXISTS idx_push_log_user ON push_log(user_id, created_at);

-- ========== 用户设置 ==========
CREATE TABLE IF NOT EXISTS settings (
  user_id          TEXT PRIMARY KEY,
  bark_keys        TEXT NOT NULL DEFAULT '[]',
  bark_server      TEXT NOT NULL DEFAULT 'https://api.day.app',
  bark_group       TEXT,
  bark_sound       TEXT,
  bark_level       TEXT NOT NULL DEFAULT 'active',
  advance_days     INTEGER NOT NULL DEFAULT 7,
  advance_km       INTEGER NOT NULL DEFAULT 500,
  item_overrides   TEXT NOT NULL DEFAULT '{}',
  notify_enabled   INTEGER NOT NULL DEFAULT 1,
  timezone_offset  INTEGER NOT NULL DEFAULT 8,
  ai_channel       TEXT NOT NULL DEFAULT 'workers-ai',
  ai_model         TEXT,
  ai_base_url      TEXT,
  ai_api_key_enc   TEXT,
  keep_raw_image   INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL
);

-- ========== 待确认的识别结果 ==========
CREATE TABLE IF NOT EXISTS pending_uploads (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  vehicle_id    TEXT,
  target        TEXT NOT NULL DEFAULT 'record',
  ai_channel    TEXT,
  ai_model      TEXT,
  image_mime    TEXT,
  image_thumb   TEXT,
  ai_raw        TEXT,
  parsed_json   TEXT NOT NULL,
  error         TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_uploads(user_id, created_at);

-- ========== 全站配置（管理员控制的开关） ==========
-- key/value 一张表装下所有全局开关，以后再加开关不用改表结构。
-- 现在装这些：
--   registration_open '1' 开放注册（默认）/ '0' 关闭注册
--   feedback_url / group_url / group_qr / group_title —— 设置页「关于」卡片的外链（FEAT-001/002）
CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ========== 产品公告（FEAT-003） ==========
-- 管理员发新公告 → 用户登录后自动弹窗一次；点关闭写 announcement_reads，之后不再弹。
CREATE TABLE IF NOT EXISTS announcements (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT 'info',   -- info / warn / important
  published  INTEGER NOT NULL DEFAULT 1,     -- 0=撤回（存着但用户看不到）
  created_at TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_announce_created ON announcements(created_at DESC);

-- 已读记录：主键天然去重，同一用户同一公告只记一次
CREATE TABLE IF NOT EXISTS announcement_reads (
  user_id         TEXT NOT NULL,
  announcement_id TEXT NOT NULL,
  read_at         TEXT NOT NULL,
  PRIMARY KEY (user_id, announcement_id)
);

-- ========== 保养项目目录（内置周期表） ==========
CREATE TABLE IF NOT EXISTS item_catalog (
  code            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  aliases         TEXT NOT NULL DEFAULT '',
  interval_months INTEGER,
  interval_km     INTEGER,
  category        TEXT,
  source          TEXT NOT NULL DEFAULT 'builtin',
  enabled         INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 100,
  note            TEXT
);

INSERT OR REPLACE INTO item_catalog (code, name, aliases, interval_months, interval_km, category, sort_order, note) VALUES
 ('engine_oil',   '机油',       '机油,发动机油,润滑油,全合成机油,半合成机油,矿物质机油', 6,  5000,  '油液', 10, '全合成可延至 10000km/12 个月'),
 ('oil_filter',   '机油滤芯',   '机滤,机油滤,机油滤清器,机油格',                            6,  5000,  '滤芯', 20, '随机油一同更换'),
 ('air_filter',   '空气滤芯',   '空滤,空气滤,空气滤清器,空气格',                            12, 10000, '滤芯', 30, NULL),
 ('cabin_filter', '空调滤芯',   '空调滤,空调滤清器,空调格,PM2.5滤芯',                       12, 10000, '滤芯', 40, NULL),
 ('fuel_filter',  '汽油滤芯',   '汽滤,燃油滤,汽油滤清器,汽油格',                            24, 30000, '滤芯', 50, NULL),
 ('brake_fluid',  '刹车油',     '制动液,刹车液,制动油',                                      24, 40000, '油液', 60, NULL),
 ('coolant',      '防冻液',     '冷却液,水箱水,防冻冷却液',                                  48, 60000, '油液', 70, NULL),
 ('spark_plug',   '火花塞',     '火嘴,点火塞',                                               48, 40000, '点火', 80, '铱金可延至 60000-100000km'),
 ('gearbox_oil',  '变速箱油',   '波箱油,ATF,齿轮油,变速器油',                                48, 60000, '油液', 90, NULL),
 ('steering_oil', '转向助力油', '助力油,方向机油,转向油',                                    24, 40000, '油液', 100, NULL),
 ('brake_pad',    '刹车片',     '制动片,刹车皮,制动块',                                      24, 40000, '制动', 110, '按实际磨损更换'),
 ('brake_disc',   '刹车盘',     '制动盘,刹车碟',                                             60, 80000, '制动', 120, '按实际磨损更换'),
 ('tire',         '轮胎',       '车胎,外胎,防爆胎,静音轮胎',                                 60, 60000, '轮胎', 130, '或按胎面磨损标记'),
 ('battery',      '电瓶',       '蓄电池,蓄电瓶,启动电池,AGM电池',                            42, NULL,  '电气', 140, NULL),
 ('wiper',        '雨刮片',     '雨刷,雨刮器,雨刷片,雨刮条',                                  12, NULL,  '外观', 150, NULL),
 ('ac_filter',    '空调滤网',   '进气滤网,车内滤网',                                          12, 10000, '滤芯', 160, NULL),
 ('timing_belt',  '正时皮带',   '时规带,正时带,正时链条',                                     72, 80000, '发动机', 170, '以厂家手册为准'),
 ('drive_belt',   '发电机皮带', '附件皮带,多楔带,风扇皮带',                                   60, 60000, '发动机', 180, NULL),
 ('clutch',       '离合器',     '离合片,离合器片,离合器总成',                                 NULL, 80000, '传动', 190, '按实际磨损更换'),
 ('shock',        '减震器',     '避震,减震筒,减震总成',                                        NULL, 80000, '底盘', 200, '按漏油/异响情况'),
 ('tie_rod',      '球头/拉杆',  '转向拉杆,球笼,悬挂球头',                                      NULL, 80000, '底盘', 210, NULL),
 ('antifreeze',   '玻璃水',     '雨刮水,洗涤液,玻璃清洗液',                                   6,  NULL,  '耗材', 220, NULL),
 ('wheel_align',  '四轮定位',   '定位,动平衡,轮胎平衡',                                      12, 20000, '服务', 230, NULL),
 ('inspection',   '全车检测',   '免费检测,常规检查,全车检查,保养检测',                        6,  NULL,  '服务', 240, NULL);
