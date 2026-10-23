// 20261020 v2 · 养鱼免单周评估定时脚本
//
// 调度（必须周一 00:10，不能是周日 23:50）：
//   10 0 * * 1 /usr/bin/node /opt/yangyu-miandan/scripts/weekly-eval.js >> /var/log/yangyu-weekly-eval.log 2>&1
//
// 为什么改时点：连续 5 天的合法起点只有周一/周二/周三，最典型形态是「周三→周日」，
// 第 5 天正好是周日。周日 23:50 评估会让 23:55 才投喂的用户被判未达标 ——
// 最容易达标的人反而被罚。改为周一凌晨评估「上一 ISO 周」，数据必然完整。
//
// 幂等：服务端 weekly_eval_log 唯一键 (enrollment_id, week)，重复执行安全。
// 认证：自签 OPERATOR 短时 JWT（auth 中间件只验签不查库），不落长期凭据。
const NM = "/opt/yangyu-miandan/node_modules/";
require(NM + "dotenv").config({ path: "/opt/yangyu-miandan/.env" });
const jwt = require(NM + "jsonwebtoken");

const BASE = process.env.YANGYU_BASE || "http://127.0.0.1:8080";

function token() {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET 未加载，检查 /opt/yangyu-miandan/.env");
  return jwt.sign(
    { userId: "cron-weekly-eval", role: "OPERATOR", merchantId: "" },
    process.env.JWT_SECRET,
    { expiresIn: "10m" }
  );
}

async function post(path) {
  const resp = await fetch(BASE + path, {
    method: "POST",
    headers: { authorization: "Bearer " + token(), "content-type": "application/json" },
  });
  const j = await resp.json().catch(() => null);
  console.log(new Date().toISOString(), path, "HTTP", resp.status, JSON.stringify(j));
  return { ok: resp.ok && j && j.ok === true, body: j };
}

async function main() {
  // v2：评估上一 ISO 周（含未核销期次的未达标判定 + 惩罚阶梯推进）
  const r = await post("/api/periods/evaluate");
  if (!r.ok) process.exit(1);

  // 评估后立刻扫一次作废，保证 C 端看到的期次状态与评估结果一致
  await post("/api/periods/sweep");
}

main().catch((e) => {
  console.error(new Date().toISOString(), "FATAL", e && e.message);
  process.exit(1);
});
