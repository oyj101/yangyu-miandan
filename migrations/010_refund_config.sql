-- 010: 退款公式配置（运营台 /api/reward/refund-config 持久化，契约 v1.0 2026-11-02）
-- 单行表：id CHECK(id=1) 保证恒一行。语义红线：本配置是「新建卡缺省公式」，
-- 不是全局运行时旋钮；存量卡按购卡时快照结算，绝不回刷。
-- 引擎硬约束：refundNowRatio ≡ 1 − refundShareRatio（period.service / project.view 补数关系）。
CREATE TABLE IF NOT EXISTS yangyu_refund_config (
  id TINYINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  caliber ENUM('unit','total') NOT NULL DEFAULT 'unit',
  refund_now_ratio  DECIMAL(5,4) NOT NULL DEFAULT 0.7000,
  refund_share_ratio DECIMAL(5,4) NOT NULL DEFAULT 0.3000,
  streak_days TINYINT UNSIGNED NOT NULL DEFAULT 5,
  updated_by VARCHAR(64) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

-- 幂等种子行（重复执行不影响已有配置值）
INSERT INTO yangyu_refund_config (id) SELECT 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM yangyu_refund_config WHERE id = 1);
