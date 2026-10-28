// 20261018 P1-2 · 养鱼免单周评估定时脚本
// 用途：把「PO 惩罚阶梯 pause1 → pause3 → exit@5」真正跑起来。
// 调度：crontab 每周日 23:50（此时本周养鱼数据已完整，且尚未跨周）
//   50 23 * * 0 /usr/bin/node /opt/yangyu-miandan/src/scripts/weekly-eval.js >> /var/log/yangyu-weekly-eval.log 2>&1
// 幂等：服务端 weekly_eval_log 唯一键 (enrollment_id, week)，重复执行安全。
// 认证：自签 OPERATOR 短时 JWT（auth 中间件只验签不查库），不落任何长期凭据。
const NM = "/opt/yangyu-miandan/node_modules/";
require(NM + "dotenv").config({ path: "/opt/yangyu-miandan/.env" });
const jwt = require(NM + "jsonwebtoken");

const BASE = process.env.YANGYU_BASE || "http://127.0.0.1:8080";

async function main() {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET 未加载，检查 /opt/yangyu-miandan/.env");
  const token = jwt.sign(
    { userId: "cron-weekly-eval", role: "OPERATOR", merchantId: "" },
    process.env.JWT_SECRET,
    { expiresIn: "10m" }
  );
  const resp = await fetch(BASE + "/api/reward/evaluate-all", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  });
  const j = await resp.json().catch(() => null);
  console.log(new Date().toISOString(), "HTTP", resp.status, JSON.stringify(j));
  if (!resp.ok || !j || j.ok !== true) process.exit(1);
}

main().catch((e) => {
  console.error(new Date().toISOString(), "FATAL", e && e.message);
  process.exit(1);
});
