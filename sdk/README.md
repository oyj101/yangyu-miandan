# octo-yangyu · 养鱼免单内联 SDK

本目录是**唯一交付形态**：养鱼免单没有独立站点，页面由既有联邦站承载，本 SDK 负责数据与区块渲染。

## 1. 宿主怎么接（三段代码）

```html
<!-- ① 引入（必须带缓存戳，改 SDK 必须 bump TOKv） -->
<script src="/shared/octo-sdk/modules/octo-yangyu.v2.0.0.js?v=TOKv83"></script>

<!-- ② 给容器（容器宽高由宿主决定，SDK 不改宿主动线） -->
<section id="yy-projects"></section>

<!-- ③ 挂载 -->
<script>
  Octo.Yangyu.mount('yy-projects', { view: 'projects', pageSize: 20 });
</script>
```

- C 端集合页：`{ view: 'projects' }`
- 我的养鱼：`{ view: 'mine' }`
- 商户核销台：`{ view: 'checkin' }`
- 商户结算：`{ view: 'merchant' }`
- 运营工作台：`{ view: 'ops' }`
- 消息中心：`{ view: 'notices' }`

宿主若要用自己的皮肤（推荐，避免同页出现两种视觉），**不要用 mount**，只用数据层：

```js
const { items } = await Octo.Yangyu.getProjects({ category: '餐饮', sort: 'new' });
// 自己渲染；金额口径用 Octo.Yangyu.util.money()
```

### 集合页字段（2026-10-21 起）

`getProjects` 返回的是**列表投影**，字段与详情不同：

| 有 | 没有（刻意） |
|---|---|
| `totalPrice`、`periods`、`refundClaim`、`soldCount` | `unitPrice`、`refundNowRatio`、`refundShareRatio`、`promise` |

原因：单价 × 返还比例 = **每期返多少钱**，那是补贴强度与平台毛利，不能摆在公开集合页上（会被商家比价、被羊毛党当目标清单）。
具体金额只在 `getProject()` 的 `promise` 里返回，用于**购买确认弹层**（交易前告知义务）。
宿主自渲染集合页时也不要自行用总价除期数再乘比例去拼"每期返 ¥X"。

## 1.5 分享（谁分享绑定谁的关系）

分享入口**只在 `mine` 视图**：集合页是转化位，放分享等于分流。任何持卡人都能分享，**不要求已成交**。

```js
// ① 分享者取链接（带自己的 ai_uid，不生成邀请码；比例取自这张卡本身）
const d = await Octo.Yangyu.getShareLink(cardId);
// d = { ok, shareUrl, refParam, cardId, ratio, unlocked, invited, pendingPeriods }

// ② 分享：微信内必须由宿主持有公众号签名调 wx.shareAppMessage
Octo.Yangyu.mount('yy-mine', {
  view: 'mine',
  onShare: ({ url, title, cardId }) => wx.shareAppMessage({ title, link: url })
});

// ③ 被分享者侧：打开落地页后自动绑定（mount 时执行，登录态就绪才发请求）
await Octo.Yangyu.autoBind();          // 读 ?ref= 或此前缓存的 ref，成功后清除
await Octo.Yangyu.bindShare('12345');  // 也可显式绑定（宿主自己的登录回调里调用）

// ④ 查我的关系状态（不暴露对方身份）
await Octo.Yangyu.getShareChain();     // { invitedByOther, invitedCount, unlockedCards, unlockedAmount }
```

三条口径（2026-10-21 PO 拍板，与本仓 `share.service.ts` 文件头一致）：

1. **绑定即归因**：朋友打开链接就算绑定，不要求下单成交；绑定成功瞬间解锁分享者名下**全部卡**；
2. **首触锁定**：一个被分享者只归一任分享者（`SHARE_BIND_POLICY=last` 可改末触，代价是同一批成交被多人各解锁一次）；
3. **比例逐卡**：`card.share_ratio` 每卡独立，即时退 = 1 − 该值；已售期次用 `period` 快照，运营改卡不影响合同金额。

关掉「绑定即解锁」（`SHARE_UNLOCK_ON_BIND=false`）即退回「必须成交」的旧口径，不用改代码。

## 2. 它绝对不会做的事

| 不做 | 原因 |
|---|---|
| 提供 index.html / 自己的路由 | 一旦有页面就会演化成独立站点，与本版本定位冲突 |
| 写 localStorage / 存 token | 身份只来自 `domain=.ws.hi.cn` cookie，服务端问主站 `/auth/me` |
| 改 `document.body`、注册全局滚动/路由监听 | 宿主切页不需要卸载，无残留副作用 |
| 全局污染 CSS | 所有样式以 `.yy-` 前缀限定在一个 `<style id="octo-yangyu-css">` |
| 硬编码 0.7 / 0.3 / 5 | 比例由 `/api/sdk/meta` 与每卡 `card.share_ratio` 下发，写死在客户端必然与后端漂移 |
| 生成自己的邀请码 | 链接只带 `ai_uid`（全平台唯一身份）；再造一套邀请码等于另开一套身份体系 |
| 在集合页显示每期返还金额 | 公开位暴露补贴强度；只给总价与定性文案 |

## 3. 依赖与偏差（显式记录）

- **不依赖 octo-core**。core 的 `_buildUrl` 会给路径拼 `baseUrl`（`/api/v2`），
  把 `/yangyu-api/sdk/projects` 变成 `/api/v2/yangyu-api/...`；而 core 的 token 注入
  对 cookie 身份没有意义。故本模块自带 `fetch`（`credentials:'include'`）。
- 若宿主已有 `Octo`，`Octo.Yangyu` 会被挂上；没有也能用，同时挂 `window.OctoYangyu`。

## 4. 分发（铁律，不许绕）

```bash
# 唯一通道：先 dry-run 看差异，确认后 --apply
bash tools/deploy-sdk.sh <prev-tag> --site ai
bash tools/deploy-sdk.sh <prev-tag> --site ai --apply
```

- 登记册是 `SHA256SUMS.sdk`，不是目录内容；
- `shared/`、`shared/octo-sdk/`、`modules/` 三级 `chattr +i`，**必须先解目录再解文件**，
  改完立刻重新 `+i` 并做负向验证（写入应被拒）；
- 已知工具缺陷：`deploy-sdk.sh:index_site()` 只索引 `*.js`，`.css` 会被判「缺失」。
  本模块**刻意不带 .css 文件**（样式内联在 JS 里），既是皮肤中立，也避开该假阳性。

## 5. 启用三开关

模块要真正可用，三处必须同时打开，少一处就是「半启用」：

1. 站点 `app.js` 的 `nav[]` 增加入口（用户看得见）
2. 同一 id 加进 `live[]`（否则渲染占位页、根本不发请求）
3. 后端 `TENANT_ALLOW` 放行该 id（否则请求被拒）

## 6. 契约版本

`Octo.Yangyu.contract` = 后端 `/api/sdk/meta` 的 `contract`。字段**只增不改**。
宿主升级 SDK 时若 `contract` 不匹配，应提示刷新页面（多半是缓存戳没 bump）。
