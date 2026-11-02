-- 011: 期次计划退额（caliber 金额口径接线，方案 A 建期定案，2026-11-02 评审通过）
-- 建期时按当期 refund_config.caliber 把每期计划退额固化进期次行：
--   unit  口径: planned = round2(unit_price × ratio)（与旧公式逐分一致，零行为变化）
--   total 口径: planned = round2(price × ratio / periods)，末期待遇差额并入最后一期，
--               保证 Σplanned = round2(price × ratio) 精确匹配总额承诺
-- 快照律：caliber 在建期瞬间固化，运营事后改配置不影响任何已售期次；
--         存量行保持 NULL，doRefund 走旧公式兜底，绝不回刷。
ALTER TABLE period
  ADD COLUMN refund70_planned DECIMAL(10,2) NULL,
  ADD COLUMN refund30_planned DECIMAL(10,2) NULL;
