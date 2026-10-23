-- 005: SDK 埋点落表 + 分享成交归因（2026-10-21 PO 拍板）
--
-- 两个表，两个不同的理由：
--   1) sdk_event     —— 埋点从「只落 pino 日志」升级为可查询表。
--      日志查不出"哪个视图的购买转化低"，而内联 SDK 的迭代全靠这个数。
--      写入走内存队列批量落库（见 src/features/track/track.service.ts），
--      永不因埋点失败影响业务响应。
--   2) share_conversion —— 分享成交归因。
--      关系链真源在主站（8100 zy_users 推荐关系），**本表不存关系**，
--      只记"哪次成交解锁了谁的哪张卡"这一业务事实，用于幂等与对账。
--      判定时必须实时读主站关系链，禁止读本表代替（否则主站换绑后永久漂移）。

/* ------------------------------------------------------------------ *
 * 1) SDK 埋点
 * ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS sdk_event (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_type    VARCHAR(48)  NOT NULL COMMENT '白名单事件名（服务端校验）',
  view          VARCHAR(32)  NULL     COMMENT 'SDK 视图：projects/mine/checkin/merchant...',
  user_id       VARCHAR(64)  NULL     COMMENT '养鱼域 user_id，未登录为 NULL',
  role          VARCHAR(16)  NULL,
  card_id       VARCHAR(36)  NULL,
  enrollment_id VARCHAR(36)  NULL,
  sdk_version   VARCHAR(16)  NULL     COMMENT '宿主上报的 SDK 版本，版本错配排查用',
  payload       TEXT         NULL     COMMENT '已裁剪：键白名单 + 最大 2KB + 敏感键剔除',
  ip_hash       CHAR(16)     NULL     COMMENT 'sha256 前 16 位，不存原始 IP',
  ua_hash       CHAR(16)     NULL     COMMENT 'sha256 前 16 位，不存原始 UA',
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_event_time (event_type, created_at),
  KEY idx_user_time  (user_id, created_at),
  KEY idx_time       (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='内联 SDK 埋点（保留 90 天，daily-ops 清理）';

/* ------------------------------------------------------------------ *
 * 2) 分享成交归因（不存关系链，只存归因结果）
 * ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS share_conversion (
  id                     VARCHAR(36) NOT NULL,
  referrer_user_id       VARCHAR(64) NOT NULL COMMENT '解锁受益人（养鱼域 user_id）',
  buyer_user_id          VARCHAR(64) NOT NULL COMMENT '成交人（养鱼域 user_id）',
  buyer_ai_uid           VARCHAR(32) NOT NULL COMMENT '成交人主站 ai_uid，关系链查询锚点',
  card_id                VARCHAR(36) NOT NULL COMMENT '成交的卡',
  enrollment_id          VARCHAR(36) NULL     COMMENT '成交的入渔记录',
  unlocked_enrollment_id VARCHAR(36) NULL     COMMENT '实际被解锁的卡（推荐人没持此卡时=其最早未解锁卡）',
  backfilled             INT         NOT NULL DEFAULT 0 COMMENT '本次补齐的历史期次数',
  source                 VARCHAR(16) NOT NULL DEFAULT 'purchase' COMMENT 'purchase|manual|sweep',
  created_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_conv (referrer_user_id, buyer_user_id, card_id),
  KEY idx_buyer_time (buyer_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='分享成交归因：关系真源在主站，本表只保证幂等与对账';
