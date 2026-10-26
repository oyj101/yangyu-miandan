-- ============================================================
-- 009_delivery_fulfillment.sql · 养鱼免单「配送分支」履约模型
--
-- 背景（时序图 图有码无 第三块）：
--   此前全仓只有「到店核销」一条腿，配送/运费/签收/回传全无实现。
--   时序图要求两条腿：
--     ① 到店自提 → 到店核销（已有 checkin，不动）
--     ② 配送到家 → 运费与差价单独支付 → 配送上门 → 签收确认 → 回传配送完成
--
-- 设计要点：
--   - 履约能力配置在卡上（fulfillment），用户在购买时选择（enrollment.fulfill_mode）
--   - 运费按「每期 delivery_fee × 期数」一次性单独收（独立支付单，不并入卡价）
--   - delivery_task 一期一条（uk_delivery_period），状态机 pending→shipped→delivered→signed
--   - 签收 = 配送场景的「核销」，复用 computeOnCheckinV2 的发奖链路，
--     不另写一套资金逻辑（避免第二份发奖实现）
--
-- 兼容：全部 ADD COLUMN IF NOT EXISTS + 新表，存量卡/入渔默认 pickup 不受影响。
-- MariaDB 10.11 · InnoDB · utf8mb4
-- ============================================================


-- ------------------------------------------------------------
-- ① card：履约能力 + 运费
-- fulfillment 默认 pickup：存量卡行为完全不变（只有到店核销一条腿）。
-- delivery_fee 是「每期」运费，总额在购买时按期数一次性收取。
-- ------------------------------------------------------------
ALTER TABLE card
  ADD COLUMN IF NOT EXISTS fulfillment ENUM('pickup','delivery','both') NOT NULL DEFAULT 'pickup'
    COMMENT '支持的履约方式：pickup=仅到店自提 / delivery=仅配送到家 / both=两者皆可',
  ADD COLUMN IF NOT EXISTS delivery_fee DECIMAL(12,2) NOT NULL DEFAULT 0
    COMMENT '配送到家每期运费（差价单独收，不并入卡价）';


-- ------------------------------------------------------------
-- ② enrollment：履约选择 + 收货信息 + 运费单
-- freight_amount = delivery_fee × total_periods（一次收齐）。
-- freight_pay_status: none=免运费或未选配送 / unpaid=已下单未付 / paid / refunded
-- ------------------------------------------------------------
ALTER TABLE enrollment
  ADD COLUMN IF NOT EXISTS fulfill_mode ENUM('pickup','delivery') NOT NULL DEFAULT 'pickup'
    COMMENT '用户选择的履约方式',
  ADD COLUMN IF NOT EXISTS receiver_name    VARCHAR(64)  NULL,
  ADD COLUMN IF NOT EXISTS receiver_phone   VARCHAR(32)  NULL,
  ADD COLUMN IF NOT EXISTS receiver_address VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS freight_amount   DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '运费总额（每期×期数）',
  ADD COLUMN IF NOT EXISTS freight_pay_order_no VARCHAR(64) NULL COMMENT '运费的独立支付单号',
  ADD COLUMN IF NOT EXISTS freight_pay_status VARCHAR(16) NOT NULL DEFAULT 'none'
    COMMENT 'none=免运费/自提 / unpaid=已下单未付 / paid / refunded';


-- ------------------------------------------------------------
-- ③ checkin：核销来源
-- source=counter 到店核销 / delivery 配送签收。
-- delivery_task_id 让「签收→核销」可双向追溯（对账时要分清钱从哪条腿来）。
-- ------------------------------------------------------------
ALTER TABLE checkin
  ADD COLUMN IF NOT EXISTS source ENUM('counter','delivery') NOT NULL DEFAULT 'counter'
    COMMENT '核销来源',
  ADD COLUMN IF NOT EXISTS delivery_task_id CHAR(36) NULL;


-- ------------------------------------------------------------
-- ④ delivery_task：每期一条配送任务
-- 地址是快照（用户改地址不影响已发出的任务），与 period 的金额快照同理。
-- status 状态机由服务层 delivery.service 校验，DB 只做枚举约束。
-- 不设外键：本库历史表间均无 FK，保持一致避免批量迁移时的锁与顺序问题。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS delivery_task (
  id               CHAR(36) PRIMARY KEY,
  period_id        CHAR(36) NOT NULL,
  enrollment_id    CHAR(36) NOT NULL,
  card_id          CHAR(36) NOT NULL,
  user_id          VARCHAR(64) NOT NULL,
  merchant_id      VARCHAR(64) NOT NULL,
  period_no        INT NOT NULL,
  week_start       DATE NOT NULL,
  week_end         DATE NOT NULL,
  mode             ENUM('pickup','delivery') NOT NULL DEFAULT 'delivery',
  status           ENUM('pending','shipped','delivered','signed','cancelled') NOT NULL DEFAULT 'pending'
                   COMMENT 'pending=待配送 / shipped=已配送上门 / delivered=已送达待签收 / signed=已签收(触发核销) / cancelled=取消',
  receiver_name    VARCHAR(64)  NULL COMMENT '收货人（下单时快照）',
  receiver_phone   VARCHAR(32)  NULL,
  receiver_address VARCHAR(255) NULL,
  courier          VARCHAR(64)  NULL COMMENT '配送方/骑手',
  tracking_no      VARCHAR(64)  NULL COMMENT '配送单号',
  remark           VARCHAR(255) NULL,
  operator         VARCHAR(64)  NULL COMMENT '最后操作的商户账号',
  shipped_at       DATETIME(3) NULL,
  delivered_at     DATETIME(3) NULL,
  signed_at        DATETIME(3) NULL,
  signed_by        VARCHAR(32) NULL COMMENT 'user=本人签收 / merchant=商户代签',
  checkin_id       CHAR(36) NULL COMMENT '签收触发的核销记录',
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  -- 一期只能有一条配送任务：与 checkin 的 uk_checkin_period 同构，保证一期限一次
  UNIQUE KEY uk_delivery_period (period_id),
  KEY idx_delivery_merchant (merchant_id, status, week_end),
  KEY idx_delivery_enroll (enrollment_id),
  KEY idx_delivery_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
