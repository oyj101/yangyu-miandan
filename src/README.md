# 养鱼免单后端服务（同城智慧商业联邦 · 章鱼仔 AI 免单计划）

P0 全闭环后端：商户申请 → 运营审核 → 购买入渔 → 到店核销 → 奖励引擎 → 任务名单。
技术栈：**Express + TypeScript / MariaDB 10.11**（mysql2，与联邦站现网同引擎），认证 JWT（RBAC），实时轮询。

## 架构（按功能组织 + 三层）
```
src/
  config/        集中环境变量校验（启动即失败）
  lib/           errors(类型化) / logger(pino) / db(mysql2 连接池+事务+UUID 主键) / http(响应)
  middleware/    requestId / auth(JWT+RBAC) / errorHandler
  features/
    auth/        开发登录（签发 JWT；生产禁用）
    card/        F1 商户申请 + F2 运营审核 + 全局参数
    enrollment/  F3 购买入渔 + F7 名单查询
    checkin/     F5 到店核销（幂等）
    reward/      核心：F6 奖励引擎 + 4.3 惩罚状态机(engine.ts) + 周评估
  db/migrate.ts  迁移运行器（多语句一次执行）
  app.ts / server.ts
public/          前端页（联邦站令牌风格）：merchant-apply / operator-review / merchant-checkin / merchant-roster
migrations/      001_init.sql（MariaDB 方言）
```

## 数据库说明（选型结论）
- **MariaDB 10.11**（非 PostgreSQL）：与联邦站现网同引擎，一套备份/监控/升级体系；账本类数据稳定后可迁独立实例
- 主键 `CHAR(36)` + 应用层 `randomUUID()`（MariaDB `UUID()` 非 v4，不用于主键）
- `DATETIME(3)` 存服务器本地时间（CST），部署机必须 CST 时区
- 一人一周一核销由唯一索引 `idx_checkin_dedup (enrollment_id, week)` 强制；重复核销 `1062 ER_DUP_ENTRY` → 409，事务回滚
- 事务内所有写走同一连接（`withTx` 内禁止再用 pool 另开会话——FK 共享锁与 UPDATE 排他锁会互等超时）

## 快速启动
```bash
npm install
cp .env.example .env          # 填入 DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME + JWT_SECRET
npm run migrate               # 执行建表迁移（需 MariaDB 可达）
npm run dev                   # tsx 热重载（或 npm run build && npm start）
```
> 本地联调：便携版 MariaDB 10.11.19 解压即用（mariadb-install-db 初始化 → mysqld --port=3399），
> `.env` 指 `DB_PORT=3399` 后 `node dist/integration-test.js` 一键跑全链路（自动重建测试库）。
> 若 esbuild 平台二进制缺失，用 `npm run build` + `node dist/server.js` 绕开 tsx。

## 测试
```bash
npm test                       # F6 惩罚状态机单测（10/10）
npm run typecheck              # tsc --noEmit
node dist/integration-test.js  # 全链路 CRUD 联调（25/25，需本地 mysqld:3399）
```

## 关键业务约束（PRD 4.x）
- 奖励 = 联邦消费金（不可提现）；免单覆盖率默认 100%，受 `coverage_cap` 封顶。
- 惩罚状态机：正常 → 未达标首犯「停奖2」→ 连续2次「停奖6」→ 连续3次或累计6次「退出」；退出后服务继续、允许重新入渔。
- 防倒挂：单次奖励×次数 ≤ 卡售价×coverage_cap；每店限量 `per_merchant_quota`。

## 端点
| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | /api/auth/dev-login | 公开 | 开发登录签发令牌 |
| POST | /api/cards | MERCHANT | F1 申请免单卡 |
| GET | /api/cards/merchant/:id | MERCHANT/OPERATOR | 商家卡列表 |
| GET | /api/cards/pending | OPERATOR | 待审核 |
| POST | /api/cards/:id/review | OPERATOR | F2 审核 |
| GET/PUT | /api/cards/params(/:key) | OPERATOR | 全局参数 |
| POST | /api/enrollments/purchase | USER | F3 购买入渔 |
| GET | /api/enrollments/merchant/:id | MERCHANT/CASHIER/OPERATOR | F7 名单 |
| POST | /api/checkin | CASHIER/OPERATOR | F5 核销（触发发奖） |
| POST | /api/reward/evaluate | OPERATOR | 周评估（养鱼达标） |
| GET | /api/reward/:enrollmentId | — | 奖励流水 |

## 待办（后续期）
- P1：F4 养鱼打卡接入章鱼仔 AI、F8 退款（30%–70% 窗口 + clawback 营销核销）、状态机可视化。
- P2：风控反作弊、裂变分享回调、数据看板。
- 生产接入联邦统一登录（替换 dev-login），刷新令牌走 httpOnly cookie。
