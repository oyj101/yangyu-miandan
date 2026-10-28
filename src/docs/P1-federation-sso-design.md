# P1 设计：联邦统一登录接入养鱼免单

> 目标：让已上线的 `yangyu-roster.html` 集合页**真正取到数据**（当前为空态，根因是生产禁用 dev-login 后浏览器拿不到任何令牌）
> 立法依据：联邦站条例 **I-1 密钥隔离**、**H（API 治理）**；联邦站门禁 R1 缓存键 / R2 身份键唯一 `_xzy_tk` / R6 SDK 双键
> 编写日期：2026-10-15 ｜ 所有现状描述均来自生产机实测，非推测

---

## 一、现状资产盘点（实测）

| 资产 | 实测事实 | 对设计的意义 |
|---|---|---|
| 联邦身份令牌 | 存于 `localStorage._xzy_tk`；读取链 `Octo.auth.token()` → `H6.Token.get()` → `_xzy_tk`（`octo-auth.v1.0.0.js` tokenGet） | **前端无需新建登录 UI**，直接复用联邦登录态 |
| 联邦出具方 | `shared/octo-sdk/modules/octo-auth.v1.0.0.js` 契约真源：`/api/v2/member/login`、`/api/v2/wechat/login`、`/api/v2/users/profile` 等 | 已具备会员/微信双通道登录 |
| 联邦令牌算法 | HS256；payload 平铺 `{uid, user_id, iat, exp}`；`merchant_gateway.py:136 jwt_create(exp_hours=72)` | 对称验签可本地完成，**无需远程调用**（网关自己也这么做，<1ms） |
| 联邦密钥来源 | `merchant_gateway.py:_load_jwt_secret()` 读 env `JWT_SECRET` 或 `/www/wwwroot/.env` | 养鱼服务需一份**只读副本**用于验签 |
| 商户隶属关系 | `xiaozhangyu` 库已有 `zy_merchant_staff`、`zy_user_roles` | 「用户→商户+角色」映射**已有事实源**，无需新建用户体系 |
| 养鱼服务端 | `/yangyu-api` → `127.0.0.1:8080`（PM2 cluster×2）；`auth(roles)` + RBAC + 自有 `JWT_SECRET` 已上线 | 只需新增一个兑换入口，业务层零改动 |
| 集合页 | `yangyu-roster.html` 引 `octo-yangyu.v1.0.0.min.js?v=TOKv68`，当前降级空态 | SDK 升级至 v1.1.0 即接管全部鉴权 |

---

## 二、方案选型

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. 令牌兑换（推荐）** | 养鱼服务新增 `POST /api/auth/exchange`，验联邦令牌后用**自有密钥**签短期养鱼令牌 | 服务自治、令牌 TTL 可收紧到分钟级、密钥职责清晰、联邦零改造 | 需注入联邦密钥只读副本 | ✅ **采纳** |
| B. 直透联邦令牌 | 养鱼服务直接用联邦令牌做鉴权 | 零兑换逻辑 | 两服务共用一把密钥，越权面扩大；联邦令牌 72h 长 TTL 直接暴露给业务 API；无法表达养鱼专属角色 | ❌ 否决 |
| C. 网关统一鉴权 | nginx 层/password auth_request 统一校验 | 业务服务无感 | 需 lua/auth_request 子系统；角色映射仍无处安放；破坏现有 V1 形态 | ❌ 延后 |

---

## 三、方案 A 详设

### 3.1 时序

```
[浏览器]                     [联邦]                [养鱼服务]              [MariaDB]
   │  ① Octo.Auth.token() → _xzy_tk（已登录则命中，未登录则跳 login.html?redirect=）
   │                            │                      │
   │  ② POST /yangyu-api/api/auth/exchange  Bearer <fed_token>
   │                            │                      │
   │                            │            ③ HS256 验签（FEDERATION_JWT_SECRET 只读）
   │                            │               └─ 固定 algorithms:['HS256']，拒 alg=none/算法混淆
   │                            │                      │
   │                            │            ④ 取 payload.user_id → 查 federation_identity
   │                            │                      │             （fed_user_id → merchant_id, role）
   │                            │            ⑤ 未绑定 → 403 NOT_ENROLLED（明确提示，非静默空态）
   │                            │                      │
   │  ⑥ ← 200 { accessToken, role, merchantId, expiresIn:900 }
   │                            │                      │
   │  ⑦ 后续 /yangyu-api/api/** 携带养鱼令牌（15min，过期自动重兑）      │
```

### 3.2 接口契约

```
POST /api/auth/exchange
Authorization: Bearer <联邦 _xzy_tk>
200 { "ok": true, "data": { "accessToken": "...", "role": "CASHIER", "merchantId": "M001", "expiresIn": 900 } }
401 UNAUTHORIZED           联邦令牌缺失/失效/过期
403 NOT_ENROLLED           已登录但未开通养鱼商户
429 RATE_LIMITED           兑换频率超限（建议 10 次/分钟/IP）
```

**角色映射矩阵**（养鱼角色由绑定关系决定，绝不由前端传入）：

| 联邦身份 | 养鱼角色 | 可见范围 |
|---|---|---|
| `zy_merchant_staff` 店主 | `MERCHANT` | 本商户全部名单 |
| `zy_merchant_staff` 店员 | `CASHIER` | 核销 + 本商户名单只读 |
| 平台运营白名单 | `OPERATOR` | 跨商户审核 |
| 普通会员 | `USER` | 仅本人入渔记录 |

### 3.3 数据模型（迁移 `002_federation_identity.sql`）

```sql
CREATE TABLE federation_identity (
  fed_user_id    VARCHAR(64) PRIMARY KEY,          -- 联邦 user_id（来自联邦令牌 payload）
  merchant_id    VARCHAR(64) NOT NULL,
  yy_role        ENUM('USER','MERCHANT','OPERATOR','CASHIER') NOT NULL DEFAULT 'CASHIER',
  status         ENUM('active','disabled') NOT NULL DEFAULT 'active',
  bound_by       VARCHAR(64),                       -- 绑定操作人（运营）
  bound_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_fed_merchant ON federation_identity (merchant_id);
```

> **为何养鱼自治而非直读 `zy_merchant_staff`**：联邦 schema 是别人的信任边界，直连跨库查询会重蹈「Sloppy Postgresmonolith」覆辙；映射表让养鱼在联邦改版时不受影响。**演进**：联邦若提供 `/internal/users/{id}/merchant` 内部 API，则本表退化为缓存。

### 3.4 错误处理与前端态（消除「莫名著的空态」）

| 场景 | 响应 | 集合页展示 |
|---|---|---|
| 未登录联邦 | 客户端检测 `Octo.Auth.isLogin()` 为假 | 「请先登录」+ 跳 `login.html?redirect=yangyu-roster.html` |
| 401 令牌失效 | 服务端 401 | SDK 自动清除缓存令牌并重新兑换一次，仍失败则提示重新登录 |
| 403 NOT_ENROLLED | 服务端 403 | 「该账号未开通养鱼商户，请联系运营绑定」 |
| 正常无数据 | 200 + `[]` | 「本商户暂无入渔记录」（区别于异常） |

---

## 四、安全设计（对应条例）

| 项 | 措施 |
|---|---|
| **I-1 密钥隔离** | 联邦密钥以 `FEDERATION_JWT_SECRET` 注入 PM2 env，**不进版本库**；仅用于验签，养鱼签发仍用自有 `JWT_SECRET` |
| 算法固定 | 验签显式 `algorithms: ['HS256']`，拒 `alg=none` 与 RS→HS 算法混淆 |
| 最小权限令牌 | 兑出令牌 TTL **15 分钟**（远小于联邦 72h），仅含 `{userId, role, merchantId}` 三字段 |
| DB 用户 | `yangyu@localhost` 已仅授权 `yangyu_miandan`，访问映射表属本库，未扩权 |
| 传输 | 经 nginx HTTPS；服务仅绑 `127.0.0.1`（已修） |
| 限流 | 兑换端点独立计数，防令牌爆破 |

**终态演进（M3）**：联邦改签 RS256 + JWKS 公钥端点，养鱼只持公钥不再持对称密钥——彻底消除密钥复制扩散面。当前 M1 用对称密钥是在「联邦零改造」约束下的最优Trade-off。

---

## 五、改造清单（文件级）

| 层 | 文件 | 改动 |
|---|---|---|
| 后端（新增） | `migrations/002_federation_identity.sql` | 映射表 |
| 后端（新增） | `src/features/auth/exchange.ts` | 验签 + 映射 + 签发短令牌 |
| 后端（改） | `src/features/auth/auth.controller.ts` | 挂 `POST /exchange`（生产可用，与 dev-login 生产禁用互不冲突） |
| 后端（改） | `src/config/index.ts` | 新增 `federationJwtSecret`（production 环境 required） |
| SDK（新增） | `shared/octo-sdk/modules/octo-yangyu.v1.1.0.js` + `.min.js` | 新增 `withFederationAuth()`：取 `_xzy_tk` → 兑换 → 缓存 → 401 自动重兑一次 |
| 前端（改） | `yangyu-roster.html` | 引用 bump 至 `octo-yangyu.v1.1.0.min.js?v=TOKv69` + 三种状态 UI |
| 登记 | `WORK-ITEM-REGISTRY.md` / `DUALITY-REGISTRY.md` | 新文件登记（避免孤儿校验拦截） |

> **门禁提示**：新增 SDK 版本需满足 **R6 双键**（源 + min + 同提交引用）；是否触发 **R1 全站 TOKv69 bump** 以 `tools/check-cachekey.py` 实测为准（上次同类提交因未动受管 `shared/*.js` 而跳过）。

---

## 六、实施节奏

- **M1（本次建议范围）**：兑换端点 + 映射表 + SDK v1.1.0 + 集合页三态 → 页面出数据
- **M2**：运营绑定后台（复用 `operator-review` 页面样式）+ 商户自助申请流
- **M3**：RS256/JWKS 演进，消除对称密钥共享

**M1 依赖**：需联邦提供——① 一份 `JWT_SECRET` 只读副本（用于注入 `FEDERATION_JWT_SECRET`）；② 确认联邦令牌 payload 主键字段稳定为 `user_id`（若改 `uid` 需同步适配）。

---

## 七、验证方案（上线前必跑）

1. **正向**：取真实 `_xzy_tk` → 兑换 → 200 + `role/merchantId` 正确
2. **反向**：伪造令牌 / 篡改签名 / 过期令牌 → 全部 401
3. **未绑定**：未录入映射表的联邦账号 → 403 `NOT_ENROLLED`
4. **越权**：`CASHIER` 令牌访问跨商户名单 → 业务层 RBAC 拒绝
5. **重放**：兑出令牌满 15 分钟后调用 → 401，SDK 自动重兑一次成功
6. **回归**：既有的 409 双花幂等、25/25 本地联调不受影响

---

## 八、待你拍板

1. 联邦 `JWT_SECRET` 副本注入方式？（当前建议：手动写入 PM2 env，不入 git，随联邦轮转同步更新）
2. 首批 `federation_identity` 绑定数据如何录入？（运营后台 M2 vs 先行 SQL 导入）
3. 是否现在启动 M1？（M1 不触碰联邦任何服务，风险可控）
