"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushWechatTemplate = pushWechatTemplate;
const config_1 = require("../../config");
/**
 * 临期提醒的微信模板消息推送。
 *
 * 走平台 8100 已有的 /api/v2/wechat/template/send（统一 token 缓存 + openid 解析 + fail-soft）。
 * 本函数只负责「拼 data + 调一次」，绝不抛错 —— 通知是附加通道，主链路（inbox）已先落库。
 *
 * 模板字段：8100 端会把每个 data 值包成 {"value": str}，所以这里只传**纯字符串**即可。
 * 模板 52850「订座结果提醒」（20261026 实测锁定，微信一次只报一个字段错）：
 *   const1            订座结果   枚举管控！值必须在后台「管理枚举值」里配置过，缺省用 config.wechat.enumResult
 *   character_string2 拼桌人数   只收字母/数字/符号（中文非法），用期次号 P{n}
 *   thing8            预约人     ≤20 字，中文合法
 *   thing4            预约门店   ≤20 字，中文合法
 *   time3             到店时间   "2026-11-01 23:59" 或中文日期格式均可
 *   5 个字段全部必填（缺任一 = 47003 "is empty"），错配会被微信拒绝（sent=false）不投递也不会炸。
 */
/** 养鱼侧 user_id 形如 au_17，平台侧是 integer id（zy_users.id）。 */
function resolvePlatformUid(yangyuUid) {
    const m = /^au[_-]?(\d+)$/i.exec(yangyuUid || "");
    if (m)
        return Number(m[1]);
    const n = Number(yangyuUid);
    return Number.isFinite(n) && n > 0 ? n : null;
}
async function pushWechatTemplate(input) {
    const templateId = config_1.config.wechat.templateId;
    if (!templateId)
        return { sent: false, error: "WX_TEMPLATE_ID 未配置" };
    const uid = resolvePlatformUid(input.yangyuUid);
    if (!uid)
        return { sent: false, error: `无法解析平台 uid: ${input.yangyuUid}` };
    // 模板 52850 五字段全必填；调用方可经 input.fields 覆盖（notify.service 会传 time3/期次号）。
    const data = {
        const1: config_1.config.wechat.enumResult || "核销提醒",
        thing8: config_1.config.wechat.thingUser || "养鱼用户",
        thing4: config_1.config.wechat.thingStore || "养鱼免单",
        ...(input.fields || {}),
    };
    const key = config_1.config.wallet.serviceKey;
    if (!key)
        return { sent: false, error: "WALLET_SERVICE_KEY 未配置" };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
        const resp = await fetch(`${config_1.config.wallet.base}/wechat/template/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Service-Key": key },
            body: JSON.stringify({
                uid,
                template_id: templateId,
                data,
                scene: input.scene || "yangyu_notice",
            }),
            signal: ctrl.signal,
        });
        const j = (await resp.json().catch(() => null));
        if (!j)
            return { sent: false, error: `HTTP ${resp.status} 响应非 JSON` };
        return {
            sent: Boolean(j.data?.sent),
            state: j.data?.state,
            errcode: j.data?.errcode,
        };
    }
    catch (err) {
        return {
            sent: false,
            error: err?.name === "AbortError" ? "timeout" : err?.message,
        };
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=wechat.js.map