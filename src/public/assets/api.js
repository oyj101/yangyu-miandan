// 类型化 fetch 客户端（联邦日报站后台页共用）
// 令牌存储：JWT 短效访问令牌放内存（不存 localStorage，符合安全规范），刷新令牌由后端置 httpOnly cookie。
const API_BASE = (location.port === "8080" ? "http://" + location.hostname + ":8080" : "") + "/api";

let accessToken = sessionStorage.getItem("yy_access") || "";

export function setToken(t) {
  accessToken = t || "";
  if (t) sessionStorage.setItem("yy_access", t);
  else sessionStorage.removeItem("yy_access");
}

async function request(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (accessToken) headers["Authorization"] = "Bearer " + accessToken;
  const res = await fetch(API_BASE + path, { ...opts, headers, credentials: "include" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body.error && body.error.message) || "请求失败";
    throw new Error(msg);
  }
  return body.data;
}

export const api = {
  // 登录（演示用：商户/运营/客户端账号由管理后台预置；此处简化）
  login: (user_id, role, merchant_id) =>
    request("/auth/dev-login", {
      method: "POST",
      body: JSON.stringify({ user_id, role, merchant_id }),
    }).then((d) => {
      setToken(d.accessToken);
      return d;
    }),
  // 卡片
  createCard: (payload) => request("/cards", { method: "POST", body: JSON.stringify(payload) }),
  listMerchantCards: (merchantId) => request("/cards/merchant/" + merchantId),
  listPending: () => request("/cards/pending"),
  review: (id, approve, rejectReason) =>
    request("/cards/" + id + "/review", { method: "POST", body: JSON.stringify({ approve, rejectReason }) }),
  getParams: () => request("/cards/params"),
  // 入渔
  purchase: (cardId) => request("/enrollments/purchase", { method: "POST", body: JSON.stringify({ cardId }) }),
  listRoster: (merchantId, status) =>
    request("/enrollments/merchant/" + merchantId + (status ? "?status=" + status : "")),
  // 核销
  checkin: (enrollmentId) =>
    request("/checkin", { method: "POST", body: JSON.stringify({ enrollmentId }) }),
  // 奖励
  evaluateWeek: (enrollmentId, met) =>
    request("/reward/evaluate", { method: "POST", body: JSON.stringify({ enrollmentId, met }) }),
  listRewards: (enrollmentId) => request("/reward/" + enrollmentId),
};

export function toast(msg) {
  const el = document.querySelector(".toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}
