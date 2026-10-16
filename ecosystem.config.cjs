module.exports = {
  apps: [
    {
      name: "yangyu-miandan",
      script: "./dist/server.js",
      cwd: "/opt/yangyu-miandan",
      // 条例 I-10 弹性就绪：cluster 模式多副本，禁单实例垂直锁死
      instances: 2,
      exec_mode: "cluster",
      // 条例 I-1 密钥隔离：凭证一律走环境变量注入，严禁进入版本库 / .env 文件
      // 条例 I-1 密钥隔离（2026-10-16 整改）：凭证一律走 .env（权限 600，不进 git），
      // 原明文硬编码已迁出。改 .env 后须 pm2 restart --update-env 生效。
      env_file: "/opt/yangyu-miandan/.env",
      max_memory_restart: "300M",
      time: true,
    },
  ],
};
