-- 002_federation_ai_uid.sql
-- 联邦统一身份锚点（Task-193 · 2026-10-16）
--
-- 生产已于 2026-10-16 由 root 手工执行（yangyu 用户无 ALTER 权限）；
-- 本文件使该 schema 变更进入版本控制，新环境可复现。
--
-- merchant_user 是「域档案 + 角色授权」表，ai_uid 锚定主站 zy_users.id
-- （身份终身一体：role 是授权作用域，不是第二个身份）。

ALTER TABLE merchant_user
  ADD COLUMN ai_uid VARCHAR(64) DEFAULT NULL COMMENT '主站 zy_users.id（联邦身份锚点）';

CREATE UNIQUE INDEX uk_merchant_user_aiuid ON merchant_user (ai_uid);
