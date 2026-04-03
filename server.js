"use strict";

/**
 * Cloud Run 統一入口
 * 透過 SERVICE_MODE 環境變數決定啟動哪個服務：
 *   - "web"  → scheduler-web-demo（設定頁面 + 排程模擬）
 *   - 其他   → slot-monitor HTTP 觸發器（Cloud Scheduler 用）
 */

require("dotenv").config();

if (process.env.SERVICE_MODE === "web") {
  // ── 模式 A：網頁介面 ──
  require("./scheduler-web-demo/app.js");
} else {
  // ── 模式 B：slot-monitor 觸發器 ──
  const http = require("http");
  const { execFile } = require("child_process");
  const path = require("path");

  const PORT = parseInt(process.env.PORT, 10) || 8080;
  let running = false;

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", running }));
      return;
    }

    if (running) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "busy", message: "上一次執行尚未完成" }));
      return;
    }

    running = true;
    const startTime = Date.now();
    console.log(`[server] 收到觸發請求，開始執行 slot-monitor...`);

    execFile(
      "node",
      [path.join(__dirname, "slot-monitor", "index.js")],
      { timeout: 280000, env: process.env, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        running = false;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (stderr) console.error(`[slot-monitor stderr]\n${stderr}`);
        if (stdout) console.log(`[slot-monitor stdout]\n${stdout}`);

        if (error) {
          console.error(`[server] slot-monitor 失敗 (${elapsed}s):`, error.message);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", elapsed, message: error.message }));
        } else {
          console.log(`[server] slot-monitor 完成 (${elapsed}s)`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", elapsed }));
        }
      }
    );
  });

  server.listen(PORT, () => {
    console.log(`[server] Cloud Run HTTP server listening on port ${PORT}`);
  });
}
