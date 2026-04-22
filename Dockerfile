FROM node:20-alpine

WORKDIR /app

# 时区
ENV TZ=Asia/Shanghai
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

# 安装依赖
COPY package.json ./
RUN npm install --omit=dev

# 复制源码
COPY server.js index.html admin.html ./

# data 目录由 Volume 挂载
RUN mkdir -p /app/data

EXPOSE 3000

ENV PORT=3000 NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
