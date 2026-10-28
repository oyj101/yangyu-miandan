// 20261026 T-243 · 养鱼免单临期提醒调度脚本
// 用途：把已实现但从未被调度的 runNoticeScan() 真正跑起来。
//   此前 notify.controller.ts 注释写着「cron 09:00 / 20:00」，但 crontab 里
//   从来没有这条 —— 每日提醒代码是完整的，只是一次都没执行过。
// 调度（每日两次，早间提醒「今天要做的事」+ 傍晚兜底「今天还没做的事」）：
//   0 9,20 * * * /usr/bin/node /opt/yangyu-miandan/src/scripts/notice-scan.js >> /var/log/yangyu-notice-scan.log 2>&1
// 幂等：服务端 biz_key 唯一键 {type}:{periodId} + period.notice_flags 双保险，
//   同一天重复执行不会重复发，改调度时间也不会补发历史。
// 认证：自签 OPERATOR 短时 JWT（auth 中间件只验签不查库），不落任何长期凭据。
const NM = "/opt/yangyu-miandan/node_modules/";
require(NM + "dotenv").config({ path: "/opt/yangyu-miandan/.env" });
const jwt = require(NM + "jsonwebtoken");

const BASE = process.env.YANGYU_BASE || "http://127.0.0.1:8080";

async function main() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET 未加载，检查 /opt/yangyu-miandan/.env");
  }
  const token = jwt.sign(
    { userId: "cron-notice-scan", role: "OPERATOR", merchantId: "" },
    process.env.JWT_SECRET,
    { expiresIn: "10m" }
  );
  const resp = await fetch(BASE + "/api/notify/scan", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  });
  const j = await resp.json().catch(() => null);
  console.log(new Date().toISOString(), "HTTP", resp.status, JSON.stringify(j));
  // 只有真的扫到并处理了期次才算成功；scanned=0 也正常（当天无在期期次），
  // 但 HTTP 非 2xx 或 body.ok 不为 true 必须非零退出，交给 cron 报警。
  if (!resp.ok || !j || j.ok !== true) process.exit(1);
}

main().catch((e) => {
  console.error(new Date().toISOString(), "FATAL", e && e.message);
  process.exit(1);
});
