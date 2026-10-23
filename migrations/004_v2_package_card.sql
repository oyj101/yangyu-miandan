-- ============================================================
-- 004_v2_package_card.sql · 养鱼免单 v2 套餐卡模型
-- 2026-10-20 PO 拍板：
--   ① 保留 70% 封顶 + 末段 30% 分享（核销退 7 成，分享成交再退 3 成）
--   ② 全额退由平台补贴 + 营销预算闸门
--   ③ 惩罚阶梯保留（pause1 / pause3 / exit@5）
--   ④ 自然周内任意连续 5 天（chat ∧ feed）
--   ⑤ 期次与 ISO 自然周绑定
--   ⑥ 核销撤销追商户负余额，下期抵扣
--   附：退至余额不可提现；未核销作废前必须推送提醒
-- MariaDB 10.11 · InnoDB · utf8mb4
-- ============================================================


-- ------------------------------------------------------------
-- ① 【阻断项·P0】修复 status ENUM
-- 001_init.sql 定义为 ('normal','pause2','pause6','exited','refunded')，
-- 但 engine.ts:41-44 实际写入 pause1 / pause3。
-- 后果：STRICT 模式 1265 Data truncated → evaluate-all 整批事务回滚
--       （周评估从未成功落库）；非 STRICT 模式静默写空串 →
--       reward.service.ts:33 判定非可核销态 → 用户到店被拒。
-- pause2/pause6 保留在枚举内：历史行若存在，删值会导致读写报错。
-- ------------------------------------------------------------
-- 非 STRICT 模式下写入的非法值会存成空串，MODIFY ENUM 时会报
-- "Data truncated at row N"。先修数据再改结构。
-- 若这条 UPDATE 影响到行，说明历史周评估确实失败过（应是 0 行）。
UPDATE enrollment SET status = 'normal' WHERE status = '';

ALTER TABLE enrollment
  MODIFY COLUMN status
    ENUM('normal','pause1','pause3','pause2','pause6','exited','refunded')
    NOT NULL DEFAULT 'normal';


-- ------------------------------------------------------------
-- ② card：套餐四要素 + 集合页字段
-- 设计权从商户（MERCHANT）移到平台（OPERATOR）。
-- ck_card_pkg_total  防空壳定价：单价 × 期数 必须等于卡价
-- ck_card_pkg_noinv  防倒挂：供应价不得高于单价（业务软上限 30% 在服务层校验）
-- 旧卡 unit_price/periods 为 NULL 时 CHECK 求值为 NULL，SQL 视为通过，兼容存量
-- ------------------------------------------------------------
ALTER TABLE card
  ADD COLUMN IF NOT EXISTS unit_price   DECIMAL(12,2) NULL COMMENT '单价（每期）',
  ADD COLUMN IF NOT EXISTS periods      INT NULL           COMMENT '总期数',
  ADD COLUMN IF NOT EXISTS supply_price DECIMAL(12,2) NULL COMMENT '供应价（核销即结商户）',
  ADD COLUMN IF NOT EXISTS category     VARCHAR(32) NULL   COMMENT '集合页分类',
  ADD COLUMN IF NOT EXISTS cover_url    VARCHAR(512) NULL  COMMENT '集合页封面',
  ADD COLUMN IF NOT EXISTS sort_weight  INT NOT NULL DEFAULT 0 COMMENT '集合页排序权重',
  ADD COLUMN IF NOT EXISTS listed_at    DATETIME(3) NULL   COMMENT '上架时间',
  -- 2026-10-20 SDK 内联版补齐：集合页没有「项目名」就无法渲染，
  -- 此前 suppliesName 只写进 audit.after（JSON 不可查询、不可排序），属于只写不读的死字段。
  ADD COLUMN IF NOT EXISTS title         VARCHAR(120) NOT NULL DEFAULT '' COMMENT '项目名（商品/服务，集合页主标题）',
  ADD COLUMN IF NOT EXISTS subtitle      VARCHAR(255) NULL COMMENT '一句话卖点（集合页副标题）',
  ADD COLUMN IF NOT EXISTS merchant_name VARCHAR(120) NULL COMMENT '商户展示名（选品时录入，避免 C 端再去 join 商户域）',
  ADD CONSTRAINT IF NOT EXISTS ck_card_pkg_total CHECK (unit_price IS NULL OR periods IS NULL
                                          OR unit_price * periods = price),
  ADD CONSTRAINT IF NOT EXISTS ck_card_pkg_noinv CHECK (supply_price IS NULL OR unit_price IS NULL
                                          OR supply_price <= unit_price);


-- ------------------------------------------------------------
-- ③ period：期次（期次绑 ISO 周的唯一年真源）
-- 资金幂等落本表 + refund_flow 的 idem_key，不依赖服务层内存判断。
-- checkin_id / task_met / refund70_* / refund30_* 各自独立置位，
-- 不复用复合状态机，避免"核销了但没退"这类中间态无处表达。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS period (
  id               CHAR(36) PRIMARY KEY,
  enrollment_id    CHAR(36) NOT NULL,
  card_id          CHAR(36) NOT NULL,
  user_id          VARCHAR(64) NOT NULL,
  merchant_id      VARCHAR(64) NOT NULL,
  period_no        INT NOT NULL COMMENT '1..N，与该入渔的总期数对应',
  iso_year         SMALLINT NOT NULL,
  iso_week         TINYINT  NOT NULL COMMENT '1..53（ISO-8601）',
  week_start       DATE NOT NULL COMMENT '该 ISO 周周一',
  week_end         DATE NOT NULL COMMENT '该 ISO 周周日',
  unit_price       DECIMAL(12,2) NOT NULL COMMENT '单价（本期的用户应退基数）',
  supply_price     DECIMAL(12,2) NOT NULL COMMENT '供应价（本期结给商户）',
  checkin_id       CHAR(36) NULL COMMENT '已核销的 checkin 记录',
  task_met         TINYINT NOT NULL DEFAULT 0 COMMENT '连续 5 天 chat∧feed 达标',
  met_days         INT NOT NULL DEFAULT 0 COMMENT '达成的最长连续天数',
  data_available   TINYINT NOT NULL DEFAULT 0 COMMENT '核销时任务数据是否可用（0=不可用，周评估跳过不惩罚）',
  window_start     DATE NULL COMMENT '达标窗口起点（用于展示与申诉）',
  refund70_amount  DECIMAL(12,2) NOT NULL DEFAULT 0,
  refund70_flow    VARCHAR(64) NULL COMMENT '8100 wallet flow_no',
  refund70_at      DATETIME(3) NULL,
  refund30_amount  DECIMAL(12,2) NOT NULL DEFAULT 0,
  refund30_flow    VARCHAR(64) NULL,
  refund30_at      DATETIME(3) NULL,
  merchant_settled TINYINT NOT NULL DEFAULT 0,
  merchant_amount  DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '本期实际结给商户的净额',
  expired          TINYINT NOT NULL DEFAULT 0 COMMENT '逾期未核销作废',
  extended_from    VARCHAR(16) NULL COMMENT '因补期并入，记录原 ISO 周',
  notice_flags     INT NOT NULL DEFAULT 0 COMMENT '通知位图（见 NOTICE 常量），防重复推送',
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_period_no   (enrollment_id, period_no),
  UNIQUE KEY uk_period_week (enrollment_id, iso_year, iso_week),
  KEY idx_period_week (iso_year, iso_week),
  KEY idx_period_user (user_id),
  KEY idx_period_merchant (merchant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ------------------------------------------------------------
-- ④ task_daily：孪生任务日聚合（连续 5 天的唯一判据来源）
-- 真源在孪生/8100 侧，本表只是判定快照；禁止反向写入孪生库，
-- 只允许经 8100 /yangyu/task-days 拉取后 upsert。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_daily (
  id            CHAR(36) PRIMARY KEY,
  enrollment_id CHAR(36) NOT NULL,
  user_id       VARCHAR(64) NOT NULL,
  task_date     DATE NOT NULL,
  chat_cnt      INT NOT NULL DEFAULT 0 COMMENT '投孪生工程聊天条数',
  feed_cnt      INT NOT NULL DEFAULT 0 COMMENT '投喂次数',
  met           TINYINT NOT NULL DEFAULT 0 COMMENT 'chat_cnt>0 AND feed_cnt>0',
  synced_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_task_daily (enrollment_id, task_date),
  KEY idx_task_date (task_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ------------------------------------------------------------
-- ⑤ merchant_account：商户结算账户
-- balance 允许负数（DECIMAL 默认 signed）。
-- 严禁改为 UNSIGNED，严禁加 CHECK (balance >= 0)：
-- 核销撤销时商户可能已结清，只能形成欠款，下一期结算先冲抵。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merchant_account (
  merchant_id VARCHAR(64) PRIMARY KEY,
  balance     DECIMAL(12,2) NOT NULL DEFAULT 0
              COMMENT '可为负：撤销核销后形成的商户欠款',
  state       ENUM('active','suspended') NOT NULL DEFAULT 'active',
  note        VARCHAR(255) NULL,
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ------------------------------------------------------------
-- ⑥ merchant_settle_ledger：商户结算流水
-- idem_key 唯一 → 重复回调/重放不产生二次入账。
-- kind: settle=应付、clawback=追回、offset=用欠款抵扣本期应付
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merchant_settle_ledger (
  id            CHAR(36) PRIMARY KEY,
  merchant_id   VARCHAR(64) NOT NULL,
  period_id     CHAR(36) NULL,
  kind          ENUM('settle','clawback','offset') NOT NULL,
  amount        DECIMAL(12,2) NOT NULL COMMENT '正=应付商户，负=追回',
  offset_amount DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '本期被欠款抵扣掉的金额',
  balance_after DECIMAL(12,2) NOT NULL,
  biz_ref       VARCHAR(64) NULL COMMENT 'checkin_id / audit_id',
  idem_key      VARCHAR(128) NOT NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_settle_idem (idem_key),
  KEY idx_settle_merchant (merchant_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ------------------------------------------------------------
-- ⑦ marketing_budget：平台补贴额度闸门
-- 单期最大净流出 = 供应价 C；预算耗尽只停售新卡，不停已售卡兑付。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketing_budget (
  id           CHAR(36) PRIMARY KEY,
  scope        ENUM('global','card') NOT NULL DEFAULT 'global',
  card_id      CHAR(36) NULL,
  period_key   VARCHAR(16) NOT NULL COMMENT 'yyyy-MM 月度口径',
  budget_total DECIMAL(14,2) NOT NULL,
  used         DECIMAL(14,2) NOT NULL DEFAULT 0,
  state        ENUM('active','exhausted','closed') NOT NULL DEFAULT 'active',
  operator     VARCHAR(64) NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_budget (scope, card_id, period_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ------------------------------------------------------------
-- ⑧ refund_flow：用户退费流水
-- 与 reward 分表：reward=营销费用（科目不同），refund=销售退回。
-- channel 目前仅 balance（不可提现的消费金）；original 待微信退款 API。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refund_flow (
  id             CHAR(36) PRIMARY KEY,
  enrollment_id  CHAR(36) NOT NULL,
  period_id      CHAR(36) NULL,
  user_id        VARCHAR(64) NOT NULL,
  kind           ENUM('refund70','refund30','refund_all','clawback') NOT NULL,
  amount         DECIMAL(12,2) NOT NULL,
  channel        ENUM('balance','original') NOT NULL DEFAULT 'balance',
  wallet_flow_no VARCHAR(64) NULL,
  state          ENUM('pending','done','failed') NOT NULL DEFAULT 'pending',
  idem_key       VARCHAR(128) NOT NULL,
  err_msg        VARCHAR(255) NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_refund_idem (idem_key),
  KEY idx_refund_enroll (enrollment_id),
  KEY idx_refund_state (state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ------------------------------------------------------------
-- ⑨ notify_message：站内消息（目前无任何通知能力，这是投诉主因）
-- biz_key 幂等：同一期次同一类型提醒只发一次。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notify_message (
  id        CHAR(36) PRIMARY KEY,
  user_id   VARCHAR(64) NOT NULL,
  ai_uid    VARCHAR(64) NULL,
  type      VARCHAR(48) NOT NULL COMMENT 'period_start / streak_warn / checkin_remind / expired / pause / refund_arrived',
  title     VARCHAR(120) NOT NULL,
  body      VARCHAR(500) NOT NULL,
  ref_type  VARCHAR(32) NULL,
  ref_id    VARCHAR(64) NULL,
  channel   ENUM('inbox','wechat','sms') NOT NULL DEFAULT 'inbox',
  state     ENUM('sent','read') NOT NULL DEFAULT 'sent',
  biz_key   VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_notify_biz (biz_key),
  KEY idx_notify_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ------------------------------------------------------------
-- ⑩ enrollment：期次锚点 + 实付
-- ------------------------------------------------------------
ALTER TABLE enrollment
  ADD COLUMN IF NOT EXISTS total_periods  INT NULL,
  ADD COLUMN IF NOT EXISTS current_period INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_week     VARCHAR(16) NULL COMMENT '首期 ISO 周 YYYYWnn',
  ADD COLUMN IF NOT EXISTS card_paid      DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '实付卡价',
  ADD COLUMN IF NOT EXISTS periods_done   INT NOT NULL DEFAULT 0 COMMENT '已核销期次数',
  ADD COLUMN IF NOT EXISTS expired_count  INT NOT NULL DEFAULT 0 COMMENT '已作废期次数',
  -- 分享解锁：整卡维度一次，不是每期一次。
  -- 逐期模式下若要求"每期分享一次"，10 期就要拉 10 个人，用户必然放弃；
  -- 沿用旧口径（推荐成交一次）解锁整卡剩余 30%，解锁时把历史已退 70% 的期次一并补齐。
  ADD COLUMN IF NOT EXISTS share_unlocked TINYINT NOT NULL DEFAULT 0 COMMENT '分享成交已解锁整卡 30%',
  ADD COLUMN IF NOT EXISTS share_unlocked_at DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS share_ref_user VARCHAR(64) NULL COMMENT '带来解锁的被推荐人';

-- ⑩-b schema 漂移回补：pay_order_no / pay_status 只存在于代码
-- (enrollment.service.ts 直接 UPDATE)，001~003 均无定义 → 新环境部署必炸。
-- 生产已手工 ALTER，此处 IF NOT EXISTS 保证可重复执行。
ALTER TABLE enrollment
  ADD COLUMN IF NOT EXISTS pay_order_no VARCHAR(64) NULL COMMENT '8100 统一支付单号',
  ADD COLUMN IF NOT EXISTS pay_status VARCHAR(16) NOT NULL DEFAULT 'none'
    COMMENT 'none=免费领卡 / unpaid=已下单未付 / paid=已实付';


-- ------------------------------------------------------------
-- ⑪ checkin：挂期次
-- 原 uk(enrollment_id, week) 保留为最后防线；新增 uk(period_id) 表达一期限一次。
-- period_id 为 NULL 的历史行不受唯一索引约束（MySQL 允许多个 NULL）。
-- ------------------------------------------------------------
ALTER TABLE checkin
  ADD COLUMN IF NOT EXISTS period_id CHAR(36) NULL,
  ADD COLUMN IF NOT EXISTS unit_price DECIMAL(12,2) NULL,
  ADD COLUMN IF NOT EXISTS supply_price DECIMAL(12,2) NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uk_checkin_period ON checkin (period_id);


-- ------------------------------------------------------------
-- ⑫ weekly_eval_log：记录判定窗口与判据版本
-- ------------------------------------------------------------
ALTER TABLE weekly_eval_log
  ADD COLUMN IF NOT EXISTS window_start DATE NULL,
  ADD COLUMN IF NOT EXISTS window_end   DATE NULL,
  ADD COLUMN IF NOT EXISTS met_method   ENUM('streak5','legacy_days','no_data') NOT NULL DEFAULT 'legacy_days';


-- ------------------------------------------------------------
-- ⑬ 参数
-- ------------------------------------------------------------
INSERT INTO global_param (`key`, value, operator) VALUES
  ('yangyu_streak_days',       5,    'system'),
  ('yangyu_refund_ratio_now',  0.7,  'system'),
  ('yangyu_refund_ratio_share',0.3,  'system'),
  ('yangyu_supply_ratio_max',  0.3,  'system'),
  ('yangyu_budget_warn_ratio', 1.2,  'system'),
  ('yangyu_notify_enabled',    1,    'system')
ON DUPLICATE KEY UPDATE value = VALUES(value);
