// 20261020 v2 · 养鱼免单每日运维扫描
//
// 调度（每天两次，覆盖早上唤醒与晚间提醒）：
//    5 9  * * * /usr/bin/node /opt/yangyu-miandan/scripts/daily-ops.js >> /var/log/yangyu-daily.log 2>&1
//    5 20 * * * /usr/bin/node /opt/yangyu-miandan/scripts/daily-ops.js >> /var/log/yangyu-daily.log 2>&1
//
// 做五件事：
//   1) 逾期作废扫描 —— 期次绑自然周，过周未核销即 expired
//   2) 站内提醒扫描 —— 含"周三最晚开始日"与"周四已无望"两条关键提醒
//   3) 退费对账 —— 扫长时间 pending 的流水（进程崩溃残留），有则告警退出码 1
//   4) 分享补偿 —— 关系链绑定晚于支付、上级后补卡的成交重判（否则这批人永远拿不到 30%）
//   5) 埋点保留 —— 删除超过保留期的 sdk_event（默认 90 天）
const NM = "/opt/yangyu-miandan/node_modules/";
require(NM + "dotenv").config({ path: "/opt/yangyu-miandan/.env" });
const jwt = require(NM + "jsonwebtoken");

const BASE = process.env.YANGYU_BASE || "http://127.0.0.1:8080";

function token() {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET 未加载");
  return jwt.sign(
    { userId: "cron-daily-ops", role: "OPERATOR", merchantId: "" },
    process.env.JWT_SECRET,
    { expiresIn: "10m" }
  );
}

async function req(method, path) {
  const resp = await fetch(BASE + path, {
    method,
    headers: { authorization: "Bearer " + token(), "content-type": "application/json" },
  });
  const j = await resp.json().catch(() => null);
  console.log(new Date().toISOString(), method, path, "HTTP", resp.status, JSON.stringify(j));
  return { ok: resp.ok && j && j.ok === true, body: j };
}

async function main() {
  await req("POST", "/api/periods/sweep");
  const n = await req("POST", "/api/notify/scan");
  const stuck = await req("GET", "/api/periods/refunds/stuck?minutes=30");

  // 分享补偿：失败不阻断其余巡检（它是"迟到的钱"，不是"错的钱"）
  const share = await req("POST", "/api/sdk/ops/share-sweep");
  if (!share.ok) console.error(new Date().toISOString(), "WARN 分享补偿失败（下次重试）");

  // 埋点保留：每天清一次，内部按 5000 行分批
  await req("POST", "/api/sdk/ops/purge-events");

  // 悬挂退费必须有告警：它是"钱的状态不确定"，不能静默
  const list = stuck.body && stuck.body.data;
  if (Array.isArray(list) && list.length > 0) {
    console.error(
      new Date().toISOString(),
      "ALERT 退费流水悬挂",
      list.length,
      JSON.stringify(list.slice(0, 5))
    );
    process.exitCode = 1;
  }
  if (!n.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(new Date().toISOString(), "FATAL", e && e.message);
  process.exit(1);
});
