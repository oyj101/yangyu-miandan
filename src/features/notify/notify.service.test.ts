import { describe, it, expect, afterAll } from "vitest";
import {
  exitChannels,
  sendWechat,
  pushExitNotice,
} from "./notify.service";
import { config } from "../../config";
import { query } from "../../lib/db";

/**
 * 退出活动通知相关测试。
 * 纯函数/通道决策不依赖 DB；幂等测试会向 notify_message 写测试行并清理。
 *
 * 本地开发机没有 MariaDB 时，DB 用例会自动 skip（而不是报 ECONNREFUSED 红一片），
 * 否则整套测试常年是红的，真正的回归反而看不见。
 *
 * 20261026 两线合并：通道开关统一为「杀开关未触发 且 wechat.templateId 非空」。
 * 模板 ID 在 config.wechat 有硬编码缺省 → 默认开启；断言从 config 推导而非写死，
 * 保证 kill-switch（WECHAT_NOTIFY_ENABLED=false）下测试仍然成立。
 */

const wechatOn = config.notify.wechat.enabled && Boolean(config.wechat.templateId);

async function dbReady(): Promise<boolean> {
  try {
    await query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

describe("exitChannels", () => {
  it("与通道开关配置一致（on=双通道 / off=仅 inbox）", () => {
    expect(exitChannels()).toEqual(wechatOn ? ["inbox", "wechat"] : ["inbox"]);
  });
});

describe("sendWechat fail-soft", () => {
  it("缺 ai_uid → skipped，不产生出站调用", async () => {
    const r = await sendWechat({ aiUid: null, type: "exit", title: "t", body: "b" });
    expect(r.sent).toBe(false);
    expect(r.skipped).toBe(true);
  });

  it("ai_uid 无法解析为平台号 → skipped", async () => {
    const r = await sendWechat({ aiUid: "not-a-uid", type: "exit", title: "t", body: "b" });
    expect(r.sent).toBe(false);
    expect(r.skipped).toBe(true);
  });
});

describe("pushExitNotice 幂等", () => {
  const enrollmentId = `test-exit-${Date.now()}`;
  const userId = `test-user-${Date.now()}`;

  afterAll(async () => {
    await query(`DELETE FROM notify_message WHERE biz_key = ?`, [`exit:${enrollmentId}`]).catch(
      () => undefined
    );
  });

  it("首次发送 inbox=true，重复发送 inbox=false（biz_key 幂等）", async (ctx) => {
    if (!(await dbReady())) return ctx.skip();
    const first = await pushExitNotice({
      userId,
      aiUid: "999",
      enrollmentId,
      cardTitle: "测试免单卡",
    });
    expect(first.inbox).toBe(true);
    // uid 999 无 openid 绑定（或通道关闭）→ wechat 不应真送达
    expect(first.wechat.sent).toBe(false);

    const second = await pushExitNotice({
      userId,
      aiUid: "999",
      enrollmentId,
      cardTitle: "测试免单卡",
    });
    expect(second.inbox).toBe(false);
  });

  it("站内信落库且 type=exit", async (ctx) => {
    if (!(await dbReady())) return ctx.skip();
    const res = await query<any>(
      `SELECT type, channel, title FROM notify_message WHERE biz_key = ?`,
      [`exit:${enrollmentId}`]
    );
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].type).toBe("exit");
    expect(res.rows[0].channel).toBe("inbox");
    expect(String(res.rows[0].title)).toContain("已退出");
  });
});
