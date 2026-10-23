-- ============================================================
-- 007 · 租户层（在既有联邦身份与统一钱包之上，不重建它们）
-- 目标模型：基础平台 → 租户子平台（ai/h6/N） → 商户门店（可跨租户接入）
--
-- 本文件基于 2026-10-21 全仓源码实测重写，修正了首版的四处臆断：
--
--   [修正 1] 不建 platform_user。
--     身份真源是主站 8100 zy_users，锚点是 ai_uid（整数）。
--     middleware/federation.ts 明写铁律：「本服务不验签、不自签用户身份，
--     只消费主站 /api/v2/auth/me 的结论；role 是授权作用域，不是第二个身份」。
--     在这里新建 platform_user，等于制造第二个身份源，直接违反该铁律。
--
--   [修正 2] 不建 tenant_user（不做第二套用户档案）。
--     merchant_user 已经是「域档案 + 角色授权」，且有 uk_merchant_user_aiuid
--     保证一个 ai_uid 只一行（002_federation_ai_uid.sql）。
--     租户层真正缺的只有一件事：**小程序 openid 归哪个租户**。
--     故只建 tenant_openid，职责单一，不碰档案与角色。
--
--   [修正 3] 不给 share_bind 加 platform_uid 列。
--     006 里 sharer_ai_uid / viewer_ai_uid 已是平台锚点，且
--     uk_viewer(viewer_ai_uid) 就是首触锁定的实现。再加两列纯属冗余。
--
--   [修正 4] 不为存量商户重新生成 ID。
--     现有 card.merchant_id / period.merchant_id / merchant_account.merchant_id
--     已经是业务码并作为主键在全链路流通。merchant 表直接承接原值，
--     只为「新入驻商户」引入 M+8 位编码规则。
--
-- 可重复执行：全部 IF NOT EXISTS / ADD COLUMN IF NOT EXISTS。
-- ============================================================

-- ------------------------------------------------------------
-- ① tenant：租户子平台注册表
--    caps 承接现有三开关（前端 nav[] → 前端 live[] → 后端 TENANT_ALLOW），
--    小程序端读同一份 caps，避免「A 租户开了外卖、B 租户没开」时点进空页面。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant (
  id              CHAR(36) PRIMARY KEY,
  code            VARCHAR(32) NOT NULL COMMENT '租户码：ai / h6 / yx / h5',
  name            VARCHAR(64) NOT NULL,
  primary_domain  VARCHAR(128) NOT NULL COMMENT '主域名，如 ai.ws.hi.cn',
  weapp_appid     VARCHAR(32) NULL COMMENT '租户小程序 appid；须与其它租户同绑一个开放平台账号，否则拿不到 unionid',
  weapp_name      VARCHAR(64) NULL,
  status          ENUM('active','paused','retired') NOT NULL DEFAULT 'active',
  caps            JSON NULL COMMENT '能力开关，与 nav[]/live[]/TENANT_ALLOW 同源',
  theme           JSON NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE UNIQUE INDEX uk_tenant_code ON tenant (code);
CREATE UNIQUE INDEX uk_tenant_appid ON tenant (weapp_appid);

-- ------------------------------------------------------------
-- ② tenant_openid：小程序通道的身份入口（唯一职责）
--    只回答一个问题：某个租户小程序里的 openid，对应哪个平台 ai_uid。
--    ai_uid 类型对齐 002（VARCHAR(64)），对齐 share_bind（VARCHAR(32)）取值形态。
--    不存角色、不存档案、不存余额 —— 那些归 merchant_user 与 8100。
--
--    openid 跨小程序不通用，这是本表存在的唯一理由；
--    unionid 只在「首次登录时用来确认是不是同一个人」时使用，不落成主键。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_openid (
  id            CHAR(36) PRIMARY KEY,
  tenant_id     CHAR(36) NOT NULL,
  open_id       VARCHAR(64) NOT NULL COMMENT '该租户小程序下的 openid',
  union_id      VARCHAR(64) NULL COMMENT '仅用于跨租户认人，可为空',
  ai_uid        VARCHAR(64) NOT NULL COMMENT '主站 zy_users.id，平台唯一锚点',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE UNIQUE INDEX uk_tenant_openid ON tenant_openid (tenant_id, open_id);
CREATE INDEX idx_tenant_openid_uid ON tenant_openid (ai_uid);
CREATE INDEX idx_tenant_openid_union ON tenant_openid (union_id);

-- ------------------------------------------------------------
-- ③ merchant：商户主表（平台级，全网商户集合）
--    id 直接承接存量 merchant_id 原值，不改写既有引用。
--    新商户编码规则：M + 8 位大写 base32（去 I/O/0/1），不用自增 ——
--    多租户并发插入必撞，且商户会把 ID 报给客服，需人眼可读。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merchant (
  id              VARCHAR(64) PRIMARY KEY COMMENT '全局商户ID，存量沿用原值；新商户 M+8位base32',
  name            VARCHAR(128) NOT NULL,
  legal_name      VARCHAR(128) NULL COMMENT '营业执照主体名',
  license_no      VARCHAR(64) NULL,
  category        VARCHAR(64) NULL COMMENT '经营品类',
  contact_phone   VARCHAR(32) NULL,
  settle_type     ENUM('light','heavy') NOT NULL DEFAULT 'light'
                  COMMENT 'light=平台统一收单后内部结算（现状）；heavy=自有商户号/服务商分账',
  settle_mch_id   VARCHAR(32) NULL COMMENT 'heavy 档商户号',
  status          ENUM('pending','active','suspended','retired') NOT NULL DEFAULT 'pending'
                  COMMENT '平台级资质审核，与租户上架审核分离',
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_merchant_status ON merchant (status);

-- ------------------------------------------------------------
-- ④ merchant_tenant：租户 ↔ 商户接入关系（多对多）
--    两段式审核：
--      merchant.status        平台审资质（能不能成为平台商户）
--      merchant_tenant.status 租户审上架（要不要在我这个站卖）
--    同一商户接入多个租户时，可逐租户覆盖供应价与分成 ——
--    period.supplyPrice 取自 card，card 归属租户，故覆盖值必须能落到卡上。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merchant_tenant (
  id                      CHAR(36) PRIMARY KEY,
  merchant_id             VARCHAR(64) NOT NULL,
  tenant_id               CHAR(36) NOT NULL,
  status                  ENUM('applied','approved','rejected','offline') NOT NULL DEFAULT 'applied',
  reject_reason           VARCHAR(255) NULL,
  settle_type_override    ENUM('light','heavy') NULL,
  supply_price_override   DECIMAL(12,2) NULL COMMENT '本租户供应价覆盖',
  share_ratio_override    DECIMAL(4,3) NULL COMMENT '本租户分成比例覆盖',
  shop_id                 VARCHAR(64) NULL COMMENT '该租户内门店号',
  approved_by             VARCHAR(64) NULL,
  approved_at             DATETIME(3) NULL,
  created_at              DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE UNIQUE INDEX uk_merchant_tenant ON merchant_tenant (merchant_id, tenant_id);
CREATE INDEX idx_mt_tenant_status ON merchant_tenant (tenant_id, status);
CREATE INDEX idx_mt_merchant ON merchant_tenant (merchant_id);

-- ------------------------------------------------------------
-- ⑤ 订单归属：收单租户 ≠ 履约租户
--    一笔单必须同时记两件事，只记一个月底算不出「谁欠谁」：
--      order_tenant_id  = 钱在哪个租户收的
--      settle_tenant_id = 货/服务在哪个租户履约（核销发生的站）
--
--    卡侧只需 tenant_id：卡在哪个站卖。
-- ------------------------------------------------------------
ALTER TABLE card
  ADD COLUMN IF NOT EXISTS tenant_id CHAR(36) NULL COMMENT '上架租户';
ALTER TABLE enrollment
  ADD COLUMN IF NOT EXISTS order_tenant_id CHAR(36) NULL COMMENT '收单租户';
ALTER TABLE enrollment
  ADD COLUMN IF NOT EXISTS settle_tenant_id CHAR(36) NULL COMMENT '履约租户（核销发生的站）';
ALTER TABLE refund_flow
  ADD COLUMN IF NOT EXISTS tenant_id CHAR(36) NULL COMMENT '退款归属租户，供分租户核算';
ALTER TABLE merchant_settle_ledger
  ADD COLUMN IF NOT EXISTS tenant_id CHAR(36) NULL COMMENT '结算归属租户，供分租户核算';

CREATE INDEX idx_card_tenant ON card (tenant_id);
CREATE INDEX idx_enroll_order_tenant ON enrollment (order_tenant_id);
CREATE INDEX idx_enroll_settle_tenant ON enrollment (settle_tenant_id);

-- ------------------------------------------------------------
-- ⑥ 平台参数（global_param 真实形态：(`key`, value DECIMAL(12,4), operator)，
--    只能存数字，说明一律写在这里）
--
--    cross_tenant_balance = 1
--      余额是平台权益（营销记账、不可提现），由 8100 wallet_service 统一动账，
--      不经微信支付，因此跨租户消费不产生票款分离与代收问题。放开。
--
--    cross_tenant_cash = 1
--      【修正】首版把它设为 0 的理由（小程序支付要求 appid 与 mchid 绑定）
--      与实际代码不符：8100 的 /yangyu/pay/create 已经是**平台单一商户号统一收单**，
--      商户侧靠 merchant_account + merchant_settle_ledger 内部记账、线下结算
--      （settleMerchant 的 cashOut 就是"实际需付出去的现金"）。
--      也就是说，"平台代收"在单租户、跨商户场景下**已经存在并在跑**，
--      跨租户只是把它从「跨商户」扩展到「跨租户」，资金模型不变。
--      故此处放开；真正的分水岭是 settle_type（light / heavy），不是租户边界。
-- ------------------------------------------------------------
INSERT INTO global_param (`key`, value, operator)
SELECT 'cross_tenant_balance', 1, 'system'
WHERE NOT EXISTS (SELECT 1 FROM global_param WHERE `key` = 'cross_tenant_balance');

INSERT INTO global_param (`key`, value, operator)
SELECT 'cross_tenant_cash', 1, 'system'
WHERE NOT EXISTS (SELECT 1 FROM global_param WHERE `key` = 'cross_tenant_cash');
