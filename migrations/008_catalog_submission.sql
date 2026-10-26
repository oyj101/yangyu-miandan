-- ============================================================
-- 008_catalog_submission.sql · 商品库选品 + 商户提报
-- 2026-10-25 PO 拍板（对齐免单时序图第 1~3 步）：
--   商户从自有商品库选品 → 设「活动供应价 + 参与数量(份数)」→ 提报
--   平台(OPERATOR)审核提报 → 据此设计套餐卡（卡关联商品、继承份数上限）
-- 此前 card.title 纯手填字符串、无商品/SPU 表，商户无从「选」——
-- 这正是时序图「图有码无」的商品库缺口。
-- MariaDB 10.11 · InnoDB · utf8mb4
-- ============================================================


-- ------------------------------------------------------------
-- ① merchant_product：商户商品库（「选品」的源头）
-- 商户维护自己的商品，提报时从这里选，不再手填 card.title。
-- status 仅商户侧上下架，不影响已生成的卡（卡生成后独立生命周期）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merchant_product (
  id           CHAR(36) PRIMARY KEY,
  merchant_id  VARCHAR(64) NOT NULL,
  name         VARCHAR(120) NOT NULL COMMENT '商品名（提报后落入 card.title 缺省）',
  category     VARCHAR(32) NULL  COMMENT '分类',
  cover_url    VARCHAR(512) NULL COMMENT '封面图',
  spec         VARCHAR(255) NULL COMMENT '规格/一句话描述',
  origin_price DECIMAL(12,2) NULL COMMENT '门市原价（参考，不参与资金计算）',
  status       ENUM('active','offline') NOT NULL DEFAULT 'active',
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_mp_merchant (merchant_id),
  KEY idx_mp_status   (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ------------------------------------------------------------
-- ② merchant_submission：商户提报（选品 + 参数 + 审核状态机）
-- supply_price = 活动供应价（商户垫资价）；quota = 参与数量（可售份数上限）
-- status: submitted → approved / rejected（OPERATOR 审核；audit 留存）
-- 与 card 解耦：一条提报审核通过后才会生成 card（designPackageCard 吃 submissionId）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merchant_submission (
  id            CHAR(36) PRIMARY KEY,
  merchant_id   VARCHAR(64) NOT NULL,
  product_id    CHAR(36) NOT NULL COMMENT '关联 merchant_product',
  supply_price  DECIMAL(12,2) NOT NULL COMMENT '活动供应价（商户垫资价）',
  quota         INT NOT NULL COMMENT '参与数量（可售份数上限）',
  status        ENUM('submitted','approved','rejected') NOT NULL DEFAULT 'submitted',
  reject_reason VARCHAR(255) NULL,
  operator      VARCHAR(64) NULL COMMENT '审核人（OPERATOR 的 userId）',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_sub_merchant (merchant_id),
  KEY idx_sub_product (product_id),
  KEY idx_sub_status  (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ------------------------------------------------------------
-- ③ card：关联商品 + 可售份数上限
-- product_id：卡绑定到某个商户商品（C 端拼场大厅可展示商品图/名）
-- stock：可售份数上限（来自提报 quota；NULL=不限）。purchase 软校验售罄。
-- 存量卡这两项均为 NULL，购买时不受 stock 限制（兼容）。
-- ------------------------------------------------------------
ALTER TABLE card
  ADD COLUMN IF NOT EXISTS product_id CHAR(36) NULL COMMENT '关联 merchant_product（商品库选品）',
  ADD COLUMN IF NOT EXISTS stock      INT NULL COMMENT '可售份数上限（来自提报 quota；NULL=不限）';
