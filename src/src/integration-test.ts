// 养鱼免单 · 全链路 CRUD 联调（本地便携 MariaDB 10.11.19 @ 127.0.0.1:3399）
// 验证 F1 申请 → F2 审核 → F3 入渔 → F5 核销发奖 → F6 奖励流水/周评估 → F7 名单
// 以及 PRD 4.3 惩罚状态机：normal → pause2 → pause6 → exited
// 前置：mysqld 已在 127.0.0.1:3399 运行（datadir 见 C:/Users/Administrator/mariadb-portable/data）
import mysql from "mysql2/promise";
import { readFileSync } from "fs";
import { join } from "path";

const PORT = 3399;
const DB = "yangyu_miandan_test";

async function main() {
  // ① 管理连接：重建干净测试库
  const admin = await mysql.createConnection({
    host: "127.0.0.1", port: PORT, user: "root", password: "", multipleStatements: true,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.query(`CREATE DATABASE \`${DB}\` DEFAULT CHARSET utf8mb4`);
  await admin.end();

  // ② 业务连接（与 db.ts 生产同参数），注入 db.ts 的 global.__myPool
  const pool = mysql.createPool({
    host: "127.0.0.1", port: PORT, user: "root", password: "", database: DB,
    waitForConnections: true, connectionLimit: 10, multipleStatements: true, timezone: "local",
  });
  (globalThis as any).__myPool = pool;

  // ③ 跑迁移（多语句一次执行）
  const sql = readFileSync(join(__dirname, "..", "migrations", "001_init.sql"), "utf8");
  await pool.query(sql);
  const [tblRows] = await pool.query(
    `SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [DB]
  );
  console.log(`迁移完成：${(tblRows as any[])[0].c} 张表`);

  const { createApp } = await import("./app");
  const app = createApp();
  const PORT_HTTP = 8099;
  const server = app.listen(PORT_HTTP);
  const base = `http://127.0.0.1:${PORT_HTTP}`;

  const results: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, cond: boolean, detail = "") => {
    results.push({ name, pass: !!cond, detail });
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  :: " + detail : ""}`);
  };

  const jpost = async (p: string, token: string | null, body: any) => {
    const r = await fetch(base + p, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  const jget = async (p: string, token: string | null) => {
    const r = await fetch(base + p, {
      method: "GET",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  const login = async (userId: string, role: string, merchantId?: string) => {
    const r = await jpost("/api/auth/dev-login", null, { user_id: userId, role, merchant_id: merchantId });
    if (r.status !== 200) throw new Error(`login ${role} 失败: ${JSON.stringify(r.data)}`);
    return (r.data.data as any).accessToken as string;
  };
  const idOf = (d: any) => d?.data?.id ?? d?.id;

  try {
    const tM = await login("m1", "MERCHANT", "shopA");
    const tO = await login("op1", "OPERATOR");
    const tU = await login("u1", "USER");
    const tC = await login("c1", "CASHIER", "shopA");
    check("dev-login 四类角色签发", !!(tM && tO && tU && tC));

    // RBAC（角色越权：当前中间件返回 401 unauthorized；语义上 403 更贴切，二者均算拦截成功）
    const rbac = await jget("/api/cards/pending", tU);
    check("RBAC：USER 访问 OPERATOR 接口被拒(401/403)", rbac.status === 401 || rbac.status === 403, `status=${rbac.status}`);

    // F1 申请（合法：10*48=480 ≤ 480*1.0）
    const apply = await jpost("/api/cards/", tM, {
      merchantId: "shopA", type: "times", times: 48, freq: "weekly",
      rewardPerTime: 10, price: 480, coverage: 1.0,
    });
    check("F1 申请免单卡(201)", apply.status === 201, `status=${apply.status}`);
    const cardId = idOf(apply.data);
    check("F1 返回 cardId(UUID格式)", !!cardId && /^[0-9a-f-]{36}$/.test(String(cardId)), String(cardId));

    // F1 负向：倒挂拦截（422 = 业务校验错误 validationError；400 = zod 结构错误）
    const bad = await jpost("/api/cards/", tM, {
      merchantId: "shopA", type: "times", times: 48, freq: "weekly",
      rewardPerTime: 20, price: 480, coverage: 1.0,
    });
    check("F1 防倒挂拦截(422)", bad.status === 422, `status=${bad.status} msg=${bad.data?.error?.message ?? ""}`);

    // F2 待审核列表
    const pend = await jget("/api/cards/pending", tO);
    check("F2 待审核列表含新卡", pend.status === 200 && Array.isArray(pend.data?.data) &&
      pend.data.data.some((c: any) => c.id === cardId), `count=${(pend.data?.data ?? []).length}`);

    // F2 审核通过
    const rev = await jpost(`/api/cards/${cardId}/review`, tO, { approve: true });
    check("F2 审核通过→active(200)", rev.status === 200 && rev.data?.data?.status === "active", `status=${rev.data?.data?.status}`);

    // F3 购买入渔
    const pur = await jpost("/api/enrollments/purchase", tU, { cardId });
    check("F3 购买入渔(201)", pur.status === 201, `status=${pur.status}`);
    const enrollId = idOf(pur.data);
    check("F3 应发奖励=480(price×coverage)", pur.data?.data?.rewardTotal === 480, `rewardTotal=${pur.data?.data?.rewardTotal}`);
    check("F3 初始状态 normal", pur.data?.data?.status === "normal", `status=${pur.data?.data?.status}`);

    // F5 核销发奖
    const ck1 = await jpost("/api/checkin/", tC, { enrollmentId: enrollId });
    check("F5 核销(201)", ck1.status === 201, `status=${ck1.status}`);
    check("F5 首核发奖=10", ck1.data?.data?.rewarded === true && ck1.data?.data?.rewardAmount === 10,
      `rewarded=${ck1.data?.data?.rewarded}, amt=${ck1.data?.data?.rewardAmount}`);

    // F5 幂等（核心资金安全）：同周重复核销被唯一索引 idx_checkin_dedup 拦截 → 409，且不多发奖
    const ckDup = await jpost("/api/checkin/", tC, { enrollmentId: enrollId });
    check("F5 同周重复核销拦截(409)", ckDup.status === 409,
      `status=${ckDup.status} msg=${ckDup.data?.error?.message ?? ""}`);
    const rwDup = await jget(`/api/reward/${enrollId}`, tU);
    check("F5 重复核销未多发奖(流水仍1条)", Array.isArray(rwDup.data?.data) && rwDup.data.data.length === 1,
      `count=${(rwDup.data?.data ?? []).length}`);

    // F6 奖励流水
    const rw = await jget(`/api/reward/${enrollId}`, tU);
    check("F6 奖励流水 1 条/10", rw.status === 200 && Array.isArray(rw.data?.data) &&
      rw.data.data.length === 1 && rw.data.data[0].amount === 10, `count=${(rw.data?.data ?? []).length}`);

    // F7 名单
    const ros = await jget(`/api/enrollments/merchant/shopA`, tM);
    check("F7 任务名单含该入渔", ros.status === 200 && Array.isArray(ros.data?.data) &&
      ros.data.data.some((e: any) => e.id === enrollId), `count=${(ros.data?.data ?? []).length}`);

    // 周评估达标保持 normal
    const ev0 = await jpost("/api/reward/evaluate", tO, { enrollmentId: enrollId, met: true });
    check("周评估 met:true 保持 normal", ev0.data?.data?.status === "normal", `status=${ev0.data?.data?.status}`);

    // 惩罚状态机 normal→pause2→pause6→exited
    const ev2 = await jpost("/api/reward/evaluate", tO, { enrollmentId: enrollId, met: false });
    check("惩罚#1 normal→pause2(pr=2)", ev2.data?.data?.status === "pause2" && ev2.data?.data?.pauseRemaining === 2,
      `status=${ev2.data?.data?.status}, pr=${ev2.data?.data?.pauseRemaining}`);
    // 模拟时间进入下一周：把该入渔最近一条核销记录改写到过去的周，腾出当前周唯一槽位
    // （一人一周一核销由唯一索引强制；真实环境中靠自然时间推进。
    //   MariaDB 不允许 UPDATE 与子查询同表，需派生表包裹）
    await pool.query(
      `UPDATE checkin SET week = ?
       WHERE id = (SELECT id FROM (SELECT id FROM checkin WHERE enrollment_id = ? ORDER BY checkin_at DESC, id DESC LIMIT 1) t)`,
      ["2025W01", enrollId]
    );
    const ck2 = await jpost("/api/checkin/", tC, { enrollmentId: enrollId });
    check("暂停期核销不发奖(pr 递减)", ck2.data?.data?.rewarded === false && ck2.data?.data?.pausedRemaining === 1,
      `rewarded=${ck2.data?.data?.rewarded}, pr=${ck2.data?.data?.pausedRemaining}`);
    const ev3 = await jpost("/api/reward/evaluate", tO, { enrollmentId: enrollId, met: false });
    check("惩罚#2 pause2→pause6(pr=6)", ev3.data?.data?.status === "pause6" && ev3.data?.data?.pauseRemaining === 6,
      `status=${ev3.data?.data?.status}, pr=${ev3.data?.data?.pauseRemaining}`);
    const ev4 = await jpost("/api/reward/evaluate", tO, { enrollmentId: enrollId, met: false });
    check("惩罚#3 pause6→exited", ev4.data?.data?.status === "exited", `status=${ev4.data?.data?.status}`);
    // 再进入下一周（同上：腾出当前周唯一槽位）
    await pool.query(
      `UPDATE checkin SET week = ?
       WHERE id = (SELECT id FROM (SELECT id FROM checkin WHERE enrollment_id = ? ORDER BY checkin_at DESC, id DESC LIMIT 1) t)`,
      ["2025W02", enrollId]
    );
    const ck3 = await jpost("/api/checkin/", tC, { enrollmentId: enrollId });
    check("退出后核销不发奖", ck3.data?.data?.rewarded === false && ck3.data?.data?.status === "exited",
      `status=${ck3.data?.data?.status}`);

    // 名单最终状态
    const ros2 = await jget(`/api/enrollments/merchant/shopA`, tM);
    const me = (ros2.data?.data ?? []).find((e: any) => e.id === enrollId);
    check("F7 名单状态=exited", me?.status === "exited", `status=${me?.status}`);

    // 数据落库终检：主键为应用层 UUID（CHAR(36)）、金额 DECIMAL 数值正确
    const [keyRows] = await pool.query(
      `SELECT id, reward_paid, reward_total FROM enrollment WHERE id = ?`, [enrollId]
    );
    const er: any = (keyRows as any[])[0];
    check("DB 层主键=UUID字符串", /^[0-9a-f-]{36}$/.test(String(er.id)), String(er.id));
    check("DB 层 reward_paid=10", Number(er.reward_paid) === 10, String(er.reward_paid));
  } catch (e: any) {
    check("执行异常", false, e?.message ?? String(e));
  }

  server.close();
  await pool.end();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== 联调结果: ${results.length - failed.length}/${results.length} PASS ====`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
