# ========== 构建阶段 ==========
FROM node:20-alpine AS builder

WORKDIR /app

# 只复制依赖文件，利用缓存层
COPY package.json pnpm-lock.yaml* package-lock.json* ./

# 优先使用 pnpm，回退到 npm
RUN corepack enable && \
    if [ -f pnpm-lock.yaml ]; then \
        pnpm install --frozen-lockfile --prod; \
    else \
        npm ci --omit=dev; \
    fi

# ========== 运行阶段 ==========
FROM node:20-alpine

WORKDIR /app

# 时区设置为上海
ENV TZ=Asia/Shanghai
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

# 从构建阶段复制 node_modules
COPY --from=builder /app/node_modules ./node_modules

# 复制应用源码
COPY server.js ./
COPY index.html ./
COPY admin.html ./

# data 目录由 Volume 挂载，这里只创建占位
RUN mkdir -p /app/data

# 暴露端口
EXPOSE 3000

# 环境变量默认值（生产环境通过 docker-compose 或 -e 覆盖）
ENV PORT=3000 \
    NODE_ENV=production

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/card/verify || exit 1

# 非 root 用户运行（安全）
RUN addgroup -S appgroup && adduser -S appuser -G appgroup && \
    chown -R appuser:appgroup /app
USER appuser

CMD ["node", "server.js"]
