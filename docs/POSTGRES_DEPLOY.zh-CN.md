# PostgreSQL Docker 部署与迁移步骤

这份文档说明如何把项目从 `data/*.json` 文件存储切换到同服务器 Docker PostgreSQL，并把已有 JSON 数据迁移到数据库。

## 一键脚本方式

在服务器进入项目目录：

```bash
cd /data/gpt-cdk-g
bash deploy-postgres.sh
```

脚本会自动完成：

- 创建或补齐 `.env`
- 生成 `POSTGRES_PASSWORD`
- 生成 `ADMIN_PASSWORD`（如果当前还是示例密码）
- 写入 `DATABASE_URL`
- 创建并启动 `postgres` Docker 服务
- 构建并启动 `app` 服务
- 等待 PostgreSQL 和 app 就绪

启动成功后，脚本会打印后台地址。登录后台后进入：

```text
系统状态 -> 数据库迁移 -> 迁移 JSON 数据到数据库
```

点击后会把以下文件导入 PostgreSQL：

- `data/cards.json`
- `data/records.json`
- `data/settings.json`
- `data/cost-records.json`

原 JSON 文件不会删除，会保留为备份。

如果你想让脚本启动后自动触发迁移：

```bash
cd /data/gpt-cdk-g
AUTO_MIGRATE=1 bash deploy-postgres.sh
```

如果自动迁移登录失败，通常是数据库里已有旧管理员密码。此时直接用后台按钮迁移即可。

## 手动部署方式

### 1. 备份当前项目

项目已有备份脚本：

```bash
cd /data/gpt-cdk-g
bash bak.sh
```

建议同时备份当前 JSON 数据：

```bash
cp -a data "data.backup.$(date +%Y%m%d-%H%M%S)"
```

### 2. 配置 `.env`

如果还没有 `.env`：

```bash
cp .env.example .env
```

编辑 `.env`，至少确认这些值：

```env
ADMIN_PASSWORD=你的后台密码
ADMIN_PATH=my-secret-admin-panel

POSTGRES_DB=miao_gpt
POSTGRES_USER=miao_gpt
POSTGRES_PASSWORD=请换成强密码
DATABASE_URL=postgres://miao_gpt:请换成强密码@postgres:5432/miao_gpt

TRUST_PROXY=1
```

注意：`POSTGRES_PASSWORD` 建议只用字母数字或十六进制字符串，避免 `@`、`/`、`:` 这类 URL 特殊字符导致 `DATABASE_URL` 解析失败。

### 3. 启动 PostgreSQL

```bash
docker compose up -d postgres
```

检查数据库是否健康：

```bash
docker compose ps
docker compose exec -T postgres pg_isready -U miao_gpt -d miao_gpt
```

### 4. 构建并启动应用

```bash
docker compose up -d --build app
```

查看日志：

```bash
docker compose logs -f app
```

看到类似下面内容说明服务已启动：

```text
卡密兑换服务已启动
数据源: PostgreSQL
```

### 5. 迁移 JSON 数据到 PostgreSQL

打开后台：

```text
http://你的域名/ADMIN_PATH
```

进入：

```text
系统状态 -> 数据库迁移 -> 迁移 JSON 数据到数据库
```

迁移按钮只有主管理员可见。迁移接口会用事务导入，重复点击不会重复插入相同主键数据。

### 6. 检查迁移结果

查看表数量：

```bash
docker compose exec -T postgres psql -U miao_gpt -d miao_gpt -c \
"select 'cards' as table_name, count(*) from cards
 union all select 'redeem_records', count(*) from redeem_records
 union all select 'cost_records', count(*) from cost_records
 union all select 'settings', count(*) from settings;"
```

查看最近迁移记录：

```bash
docker compose exec -T postgres psql -U miao_gpt -d miao_gpt -c \
"select created_at, status, cards_count, records_count, cost_records_count, message
 from migration_runs
 order by created_at desc
 limit 5;"
```

## 日常运维命令

查看服务：

```bash
docker compose ps
```

查看 app 日志：

```bash
docker compose logs -f app
```

查看 PostgreSQL 日志：

```bash
docker compose logs -f postgres
```

重启：

```bash
docker compose restart app
```

停止：

```bash
docker compose down
```

停止但保留数据库数据：

```bash
docker compose down
```

停止并删除 PostgreSQL 数据卷：

```bash
docker compose down -v
```

谨慎使用 `down -v`，它会删除数据库 volume。

## 回滚说明

如果刚部署后要回到旧版本：

```bash
cd /data/gpt-cdk-g
bash back.sh
```

如果只是想临时回到 JSON 文件模式，可以在 `.env` 中移除或注释 `DATABASE_URL`，并把 compose 里的 `DATA_SOURCE=postgres` 改成 `DATA_SOURCE=json` 后重启。但正式部署建议继续使用 PostgreSQL。

## 常见问题

### 后台按钮显示不可迁移

说明应用当前没有启用 PostgreSQL。检查：

```bash
docker compose exec app env | grep -E 'DATA_SOURCE|DATABASE_URL'
```

应该看到：

```text
DATA_SOURCE=postgres
DATABASE_URL=postgres://...
```

### app 启动失败

查看日志：

```bash
docker compose logs app
docker compose logs postgres
```

常见原因：

- `.env` 没有设置 `POSTGRES_PASSWORD`
- `DATABASE_URL` 密码和 `POSTGRES_PASSWORD` 不一致
- PostgreSQL 还没健康就启动 app

### 迁移后后台密码变了

迁移会导入原 `data/settings.json`，其中可能包含旧的 `adminPassword`。迁移完成后，以 JSON 里保存的后台密码为准。

