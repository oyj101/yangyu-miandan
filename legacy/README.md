# legacy/standalone —— 已退役的独立站点页面（2026-10-20）

这里的 4 个 HTML 与 `assets/api.js` 是**上一版**的实现形态：

- `merchant-apply.html` 商户申请
- `operator-review.html` 运营审核
- `merchant-checkin.html` 商户核销
- `merchant-roster.html` 商户名单
- `assets/api.js` 自签 JWT + `sessionStorage.yy_access` 的请求封装

## 为什么退役

本版本要求「API 内联 SDK」，不再有独立站点。这 4 个页面：

1. 自带登录（`/api/auth/dev-login` 签发本地 JWT），与联邦统一身份是两套；
2. 把访问令牌放 `sessionStorage`，与「跨子域身份必须服务端验真」的铁律冲突；
3. 一旦保留目录，就会出现「以为下线了，其实还能访问」的假退役。

`src/app.ts` 里的 `express.static` 已移除，`public/` 已不在部署树中。
**这些文件只作历史对照，不参与构建、不被打包、不得再挂到 nginx。**

替代实现：`sdk/octo-yangyu.v2.0.0.js`（视图 `checkin` / `merchant` / `ops` / `projects` / `mine`）。
