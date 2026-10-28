-- 003_weekly_eval.sql
-- 20261018 P1-2 · 周评估防重日志（批量周评估幂等基石）
--
-- 背景：惩罚阶梯 evaluateWeekly 原唯一入口是 OPERATOR 手动单条端点，
-- 全环境无任何调度 → consecutiveMiss / totalMissCount 不会自动累积，
-- pause1/pause3/exit@5 形同虚设，连带「totalMissCount>0 不可退款」门槛恒假。
-- 新增批量评估后必须保证幂等：同一入渔同一周只能评估一次，
-- 否则重复调度会把未达标次数重复累加（一次调度误判 = 直接把用户推向退出）。

CREATE TABLE IF NOT EXISTS weekly_eval_log (
  id             CHAR(36) PRIMARY KEY,
  enrollment_id  CHAR(36) NOT NULL,
  week           VARCHAR(16) NOT NULL COMMENT 'ISO-8601 周(YYYYWnn)，与 checkin.week 同口径',
  met            BOOLEAN NOT NULL DEFAULT false COMMENT '本周养鱼是否达标',
  days           INT NOT NULL DEFAULT 0 COMMENT '本周养鱼(投喂)天数',
  threshold      INT NOT NULL DEFAULT 0 COMMENT '当次评估所用阈值',
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 幂等防重：同一入渔同一周只评估一次（1062 ER_DUP_ENTRY → 跳过）
CREATE UNIQUE INDEX uk_weekly_eval ON weekly_eval_log (enrollment_id, week);
CREATE INDEX idx_weekly_eval_week ON weekly_eval_log (week);
