FROM node:20-slim

WORKDIR /app

# 複製根目錄 package 檔案 + 入口
COPY package.json package-lock.json server.js start-web.js ./

# 複製 scheduler-web-demo（含 zemo-lib/）
COPY scheduler-web-demo/package.json scheduler-web-demo/package-lock.json ./scheduler-web-demo/
COPY slot-monitor/package.json slot-monitor/package-lock.json ./slot-monitor/

# 安裝依賴
RUN npm ci --omit=dev \
 && cd scheduler-web-demo && npm ci --omit=dev \
 && cd ../slot-monitor && npm ci --omit=dev

# 複製程式碼
COPY scheduler-web-demo/ ./scheduler-web-demo/
COPY slot-monitor/ ./slot-monitor/

# 全域逾時保護（5 分鐘強制結束，避免卡住）
ENV PROCESS_TIMEOUT_MS=300000
ENV NODE_ENV=production

# Cloud Run 需要一個 HTTP 端口
EXPOSE 8080

# 統一入口：由 SERVICE_MODE 決定啟動哪個服務
CMD ["node", "server.js"]
