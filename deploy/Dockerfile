# ============================================================
# 微聊 - 生产环境镜像
# ------------------------------------------------------------
# 构建：docker build -f deploy/Dockerfile -t weiliao:latest .
# 运行：docker run -d -p 3000:3000 -v /opt/weiliao/data:/app/server/data weiliao:latest
# ============================================================

FROM node:20-alpine

WORKDIR /app

# 先装依赖，利用镜像层缓存
COPY server/package.json ./server/
RUN cd server && npm install --omit=dev --no-audit --no-fund

# 拷贝后端与前端代码
COPY server/src ./server/src
COPY client/public ./client/public

ENV NODE_ENV=production \
    PORT=3000 \
    WL_DATA_DIR=/app/server/data \
    WL_UPLOAD_DIR=/app/server/data/uploads \
    ADMIN_USER=admin \
    ADMIN_PASS=admin123

RUN mkdir -p /app/server/data/uploads

EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
