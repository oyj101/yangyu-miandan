-- 006: 分享绑定关系 + 每卡独立分成比例（2026-10-21 PO 拍板）
--
-- 三处口径变更，逐条对应 PO 原话：
--   1) 「所有卡的 30%，不管有没有交易」→ 解锁范围从「被成交的那一张卡」放宽为
--      **该分享者名下全部未解锁的套餐卡**；绑定动作本身即触发，不要求被分享者购卡。
--   2) 「谁分享绑定谁的关系」→ 新增 share_bind，sharer=分享者、viewer=被分享者。
--      一个 viewer 只归一任 sharer（uk_viewer 首触锁定），否则群里多人转发会互相覆盖，
--      同一笔钱被算多次。
--   3) 「每个商品和服务决定每个商品和服务分多少」→ card.share_ratio 每卡独立，
--      设计卡时由 OPERATOR 设定，不再是全局 0.3。
--
-- 为什么不把比例只放全局配置：
--   全局比例一旦调整，**已售卡**的合同金额会跟着变（用户买了 30% 的卡，
--   运营把默认值改成 20%，他后面几期就少拿钱）。所以比例必须落卡、并在
--   生成期次时快照到 period —— 已售出的期次金额此后不随任何配置变动。

/* ------------------------------------------------------------------ *
 * 1) 每卡分享分成比例
 * ------------------------------------------------------------------ */
ALTER TABLE card
  ADD COLUMN IF NOT EXISTS share_ratio
    DECIMAL(4,3) NOT NULL DEFAULT 0.300
    COMMENT '该卡分享返还比例（0~0.5）。即时退比例 = 1 - 本值';

/* ------------------------------------------------------------------ *
 * 2) 期次快照：金额一旦生成即冻结
 * ------------------------------------------------------------------ */
ALTER TABLE period
  ADD COLUMN IF NOT EXISTS share_ratio
    DECIMAL(4,3) NOT NULL DEFAULT 0.300
    COMMENT '生成期次时从 card 快照的分享比例（不随卡变更）',
  ADD COLUMN IF NOT EXISTS refund_now_ratio
    DECIMAL(4,3) NOT NULL DEFAULT 0.700
    COMMENT '核销即时退比例 = 1 - share_ratio';

-- 存量期次按当前卡比例回填（只补未发生过退费的期次，已退费的不动）
UPDATE period p
  JOIN card c ON c.id = p.card_id
   SET p.share_ratio      = c.share_ratio,
       p.refund_now_ratio = GREATEST(0, 1 - c.share_ratio)
 WHERE p.refund70_amount = 0
   AND p.refund30_amount = 0;

/* ------------------------------------------------------------------ *
 * 3) 分享绑定关系（养鱼域自有，不替代主站推荐关系）
 * ------------------------------------------------------------------ *
 * 与主站 zy_users 推荐关系的分工，必须一次说清，否则两套关系会打架：
 *   - 主站推荐关系 = **账号级**归属（谁把这个人带进平台），长期不变，注册时确定；
 *   - share_bind   = **分享级**归因（谁把这张卡/这个活动发给这个人），
 *     一个人可能被 5 个人分享过，只认第一条有效绑定。
 * 判定"末段返还该给谁"用 share_bind；查"这个账号的上级是谁"仍用主站。
 */
CREATE TABLE IF NOT EXISTS share_bind (
  id                VARCHAR(36) NOT NULL,
  sharer_user_id    VARCHAR(64) NOT NULL COMMENT '分享者（养鱼域 user_id）；未入驻时暂存 ai:<aiUid>',
  sharer_ai_uid     VARCHAR(32) NOT NULL COMMENT '分享者主站 ai_uid（链接里带的就是它）',
  viewer_user_id    VARCHAR(64) NOT NULL COMMENT '被分享者（养鱼域 user_id）',
  viewer_ai_uid     VARCHAR(32) NOT NULL COMMENT '被分享者主站 ai_uid，全局唯一约束锚点',
  card_id           VARCHAR(36) NULL     COMMENT '分享来源卡；NULL=通用分享入口',
  source            VARCHAR(16) NOT NULL DEFAULT 'link' COMMENT 'link|qr|manual|sweep',
  state             VARCHAR(16) NOT NULL DEFAULT 'bound' COMMENT 'bound|unlocked|rejected',
  reject_reason     VARCHAR(48) NULL     COMMENT 'SELF_REFERRAL|ALREADY_BOUND|CYCLE|NO_SHARER',
  unlocked_cards    INT           NOT NULL DEFAULT 0 COMMENT '本次解锁的卡数',
  unlocked_periods  INT           NOT NULL DEFAULT 0 COMMENT '本次补发的历史期次数',
  unlocked_amount   DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '本次补发金额（消费金）',
  unlocked_at       DATETIME(3)   NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_viewer (viewer_ai_uid),
  KEY idx_sharer_time (sharer_user_id, created_at),
  KEY idx_state (state, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='分享绑定：首触锁定，一个被分享者只归一任分享者';

/* ------------------------------------------------------------------ *
 * 4) 入渔记录：记清是哪条绑定解锁的
 * ------------------------------------------------------------------ */
ALTER TABLE enrollment
  ADD COLUMN IF NOT EXISTS share_unlocked_by
    VARCHAR(36) NULL COMMENT '触发解锁的 share_bind.id';
