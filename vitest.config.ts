import { defineConfig } from "vitest/config";

/**
 * vitest 配置（2026-10-28 新增，唯一目的：把缓存钉到项目内）
 *
 * ── 为什么要这个文件 ─────────────────────────────────────────────
 * vitest 默认把依赖预构建缓存写到**系统临时目录**（Windows 下 %TEMP%）。
 * 在受限环境（CI 容器 / 沙箱 / 企业终端管控）里对该目录写文件会 EPERM，
 * 表现为：
 *   Unhandled Error: EPERM: operation not permitted, open '...\Temp\...\ssr\...'
 *   → 冷启动时 **2 个测试文件、62 个用例被静默吞掉**（15/137 而非 17/199），
 *     且 vitest 以退出码 1 结束 → CI 判红，但报告里每个用例都是绿的（假绿）。
 *
 * 把 cacheDir 钉到 node_modules/.vite（工作区内，必然可写）后，
 * 冷启动与热启动用例数一致，退出码真实反映测试结果。
 *
 * 已知残余（环境侧，非本配置能解决）：vitest 的 SSR 转换缓存另有一处
 * 落在**系统临时目录**（Windows 下 %TEMP%\<随机>\ssr\）。在带文件系统
 * 代理/沙箱的环境里对它写文件会偶发 EPERM，表现为静默漏跑一个测试文件
 * （报告仍显示全绿）。该路径不受 cacheDir 控制，Linux CI runner 的 /tmp
 * 无此拦截，故不在此处 workaround —— 排查时认准「用例数突然变少」这一信号。
 *
 * 其余全部沿用 vitest 默认值（include/environment 等均未改），
 * 保证不因加配置而改变任何既有测试行为。
 */
export default defineConfig({
  test: {
    // 缓存落到工作区内，避免依赖系统临时目录的可写性
    cacheDir: "node_modules/.vite",
  },
});
