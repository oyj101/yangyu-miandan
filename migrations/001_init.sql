-- 养鱼免单 · 初始化 Schema (MariaDB 10.11)
-- 与 PostgreSQL 版 (git 历史) 的对应关系：
--   UUID 主键        → CHAR(36) + 应用层 randomUUID()（MariaDB UUID() 非 v4，不用于主键）
--   CREATE TYPE ENUM → 内联列 ENUM(...)
--   TIMESTAMPTZ      → DATETIME(3)（存储服务器本地时间 CST/UTC+8，now() 依赖服务器时区）
--   JSONB            → JSON
--   NUMERIC          → DECIMAL
-- 引擎 InnoDB + utf8mb4；CHECK 约束 MariaDB 10.2+ 支持

-- 商户账号（用于商户后台 / 客户端登录鉴权）
CREATE TABLE merchant_user (
  id            CHAR(36) PRIMARY KEY,
  user_id       VARCHAR(64) NOT NULL,
  merchant_id   VARCHAR(64) NOT NULL,
  role          ENUM('USER','MERCHANT','OPERATOR','CASHIER') NOT NULL DEFAULT 'MERCHANT',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_merchant_user_merchant ON merchant_user (merchant_id);
CREATE INDEX idx_merchant_user_user ON merchant_user (user_id);

-- 免单消费卡（F1 申请 → F2 审核上架）
CREATE TABLE card (
  id                CHAR(36) PRIMARY KEY,
  merchant_id       VARCHAR(64) NOT NULL,
  type              VARCHAR(16) NOT NULL CHECK (type IN ('year', 'times')),
  times             INT NOT NULL CHECK (times > 0),
  freq              VARCHAR(32) NOT NULL,
  reward_per_time   DECIMAL(12,2) NOT NULL CHECK (reward_per_time >= 0),
  price             DECIMAL(12,2) NOT NULL CHECK (price >= 0),
  coverage          DECIMAL(4,3) NOT NULL DEFAULT 1.0 CHECK (coverage >= 0 AND coverage <= 2),
  coverage_cap      DECIMAL(4,3) NOT NULL DEFAULT 1.0 CHECK (coverage_cap >= 0 AND coverage_cap <= 2),
  per_merchant_quota INT NOT NULL DEFAULT 200 CHECK (per_merchant_quota >= 0),
  status            ENUM('pending','active','offline') NOT NULL DEFAULT 'pending',
  reject_reason     TEXT,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_card_merchant ON card (merchant_id);
CREATE INDEX idx_card_status ON card (status);

-- 入渔记录（F3 购买入渔；承载 4.3 惩罚状态机）
CREATE TABLE enrollment (
  id                CHAR(36) PRIMARY KEY,
  user_id           VARCHAR(64) NOT NULL,
  card_id           CHAR(36) NOT NULL REFERENCES card (id),
  merchant_id       VARCHAR(64) NOT NULL,
  status            ENUM('normal','pause2','pause6','exited','refunded') NOT NULL DEFAULT 'normal',
  consecutive_miss  INT NOT NULL DEFAULT 0,
  total_miss_count  INT NOT NULL DEFAULT 0,
  pause_remaining   INT NOT NULL DEFAULT 0,
  reward_paid       DECIMAL(12,2) NOT NULL DEFAULT 0,
  reward_total      DECIMAL(12,2) NOT NULL DEFAULT 0,
  enroll_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  re_enrolled       BOOLEAN NOT NULL DEFAULT false
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_enroll_user ON enrollment (user_id);
CREATE INDEX idx_enroll_merchant ON enrollment (merchant_id);
CREATE INDEX idx_enroll_card ON enrollment (card_id);
CREATE INDEX idx_enroll_status ON enrollment (status);

-- 到店核销（F5；每周循环履约）
CREATE TABLE checkin (
  id              CHAR(36) PRIMARY KEY,
  enrollment_id   CHAR(36) NOT NULL REFERENCES enrollment (id),
  user_id         VARCHAR(64) NOT NULL,
  merchant_id     VARCHAR(64) NOT NULL,
  card_id         CHAR(36) NOT NULL,
  checkin_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  week            VARCHAR(16) NOT NULL,
  rewarded        BOOLEAN NOT NULL DEFAULT false,
  reward_id       CHAR(36),
  note            TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- 一人一周一核销（F5 幂等）：唯一索引拦截同周重复核销，防超额发奖。
-- 历史缺陷：曾写成 (enrollment_id, week, checkin_at)，checkin_at 微秒级精度致去重失效；
-- 修复为 (enrollment_id, week)，重复核销触发 1062 ER_DUP_ENTRY → 服务层转 409，事务回滚。
CREATE UNIQUE INDEX idx_checkin_dedup ON checkin (enrollment_id, week);
CREATE INDEX idx_checkin_merchant ON checkin (merchant_id);

-- 调理资金奖励流水（F6）
CREATE TABLE reward (
  id            CHAR(36) PRIMARY KEY,
  enrollment_id CHAR(36) NOT NULL REFERENCES enrollment (id),
  user_id       VARCHAR(64) NOT NULL,
  amount        DECIMAL(12,2) NOT NULL,
  status        ENUM('issued','pause_blocked','recalled','mkt_writeoff') NOT NULL DEFAULT 'issued',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_reward_enroll ON reward (enrollment_id);

-- 审核 / 参数变更审计（F2.2）
-- 注意：before/after 在 MariaDB 是保留字（PG 不是），必须反引号
CREATE TABLE audit (
  id          CHAR(36) PRIMARY KEY,
  operator    VARCHAR(64) NOT NULL,
  action      VARCHAR(64) NOT NULL,
  ref_type    VARCHAR(32),
  ref_id      VARCHAR(64),
  `before`    JSON,
  `after`     JSON,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_audit_ref ON audit (ref_type, ref_id);

-- 全局奖励参数（F2.2 运营配置）
CREATE TABLE global_param (
  `key`       VARCHAR(48) PRIMARY KEY,
  value       DECIMAL(12,4) NOT NULL,
  operator    VARCHAR(64),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO global_param (`key`, value, operator) VALUES
  ('coverage_cap', 1.0, 'system'),
  ('per_merchant_quota', 200, 'system'),
  ('yangyu_weekly_threshold', 5, 'system');
