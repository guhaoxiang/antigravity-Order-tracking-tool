FROM node:18-slim
WORKDIR /app

# Copy entire repo (slot-monitor depends on scheduler-web-demo + zemo-api)
COPY . .

# Install slot-monitor dependencies
WORKDIR /app/slot-monitor
RUN npm ci --production

# Install scheduler-web-demo dependencies (required by runSchedule)
WORKDIR /app/scheduler-web-demo
RUN npm ci --production

# Install zemo-api dependencies (required by geo.js, proximity.js, etc.)
WORKDIR /app/zemo-api
RUN npm ci --production

WORKDIR /app/slot-monitor
CMD ["node", "index.js"]
