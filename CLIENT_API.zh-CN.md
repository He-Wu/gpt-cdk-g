# API 文档

## 概述

本服务为 ChatGPT 账号启用 **Plus** 或 **Pro** 订阅。采用**异步 Job 模式**:提交后服务端立即回 `job_id`,client 通过 `/job/{job_id}` 查询结果。

## 基本信息

| 项目         | 值                          |
| ------------ | --------------------------- |
| Base URL     | `https://<your-domain>`     |
| 认证         | Header `X-API-Key`          |
| Content-Type | `application/json`          |

每个 API key 对 **每个 workflow 各有独立余额**(`balances.plus` / `balances.plus_1y` / `balances.pro` / `balances.pro_20x`)。提交时 client 必须指定 `workflow`,server 会扣对应 workflow 的余额;成功扣 1 点,失败自动退回该 workflow。

## Workflows

API 提供四个 workflow,对应不同订阅方案:

| name       | 用途                              |
| ---------- | --------------------------------- |
| `plus`     | 启用 ChatGPT Plus 订阅(1 个月)  |
| `plus_1y`  | 启用 ChatGPT Plus 订阅(1 年)    |
| `pro`      | 启用 ChatGPT Pro 订阅             |
| `pro_20x`  | 启用 ChatGPT Pro 订阅(20x)      |

`plus` 与 `plus_1y` 启用的都是 Plus 方案,差别在订阅期长度;`plus` 为 1 个月,`plus_1y` 为 1 年。请依想开通的订阅期选择。

每个 API Key 对每个 workflow **各有独立余额**(`balances.plus` / `balances.plus_1y` / `balances.pro` / `balances.pro_20x`)。提交时 `workflow` 为必填。

---

## 使用流程

```
┌─────────────┐    ┌────────────────┐    ┌──────────────────────┐
│ POST /submit│ ─▶ │ 回 202 job_id  │ ─▶ │ GET /job/{job_id}    │
└─────────────┘    └────────────────┘    │ (建议加 ?wait=30)    │
                                          └────────┬─────────────┘
                                                   ▼
                                         status = done / failed

 [可选] DELETE /job/{job_id} — 取消 pending 的 job,自动退费
 [可选] GET    /balance      — 查 API Key 各 workflow 余额
 [可选] GET    /queue        — 查各 workflow 目前的队列与预估等待时间
```

**建议**: `GET /job/{job_id}?wait=30` 使用 long-polling,服务端会 block 最多 30 秒直到 job 完成或 timeout,大幅减少轮询次数。

---

## POST /submit

创建启用 job,立即返回 `job_id`。不会阻塞等待实际处理。

### Request

| 字段            | 位置   | 必填 | 说明                                          |
| --------------- | ------ | ---- | --------------------------------------------- |
| `X-API-Key`     | Header | ✓    | 分配给你的 API key                            |
| `access_token`  | Body   | ✓    | ChatGPT 用户的 access token                 |
| `workflow`      | Body   | ✓    | `"plus"` / `"plus_1y"` / `"pro"` / `"pro_20x"`,决定走哪条订阅流程 |

#### Request 示例

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIs...",
  "workflow":     "pro"
}
```

### Response

#### 成功创建 — HTTP 202

```json
{
  "job_id":                 "a1b2c3d4e5f6...",
  "workflow":               "pro",
  "status":                 "pending",
  "queue_position":         2,
  "estimated_wait_seconds": 540.0
}
```

| 字段                      | 类型         | 说明                                                                |
| ------------------------- | ------------ | ------------------------------------------------------------------- |
| `queue_position`          | int \| null  | 该 job 在队列中的位置。`0` = 立即 processing;`1..N` = pending 队列中第 N 位 |
| `estimated_wait_seconds`  | float \| null| 预估到完成(含前面 job + 自己执行)总秒数,依该 workflow 最近 20 个完成 job 的平均 |

> 这两个字段为**估算值**,依当前队列长度与最近平均处理时间计算,仅供显示进度用。没有历史样本时用 fallback 180 秒。

#### 失败 — HTTP 4xx / 5xx

```json
{
  "detail": "<错误信息>"
}
```

### HTTP 状态码

| Status | 说明                                                 | 扣费 |
| ------ | ---------------------------------------------------- | ---- |
| `202`  | Job 创建成功,进入排队处理                           | 扣 1 (该 workflow 余额) |
| `400`  | 请求参数无效 (含 `workflow` 为必填、不认得的 workflow) | 不扣 |
| `401`  | 未授权 (API Key 无效)                                | 不扣 |
| `402`  | 余额不足 (该 workflow 余额为 0,信息含 workflow 名)  | 不扣 |
| `503`  | 服务暂停中                                           | 不扣 |

---

## GET /job/{job_id}

查询 job 状态。支持 long-polling 减少轮询压力。

### Request

| 字段        | 位置   | 必填 | 说明                                         |
| ----------- | ------ | ---- | -------------------------------------------- |
| `X-API-Key` | Header | ✓    | 创建该 job 时用的同一把 key                  |
| `wait`      | Query  | ✗    | Long-poll 秒数 (0-60,预设 0)。建议设 30  |

#### 示例

```
GET /job/a1b2c3d4e5f6?wait=30
```

### Response — HTTP 200

**仍处理中**(`pending` / `processing`):
```json
{
  "job_id":                 "a1b2c3d4e5f6...",
  "status":                 "pending",
  "workflow":               "pro",
  "created_at":             "2026-04-20T19:00:00+08:00",
  "completed_at":           null,
  "result":                 null,
  "error":                  null,
  "queue_position":         2,
  "estimated_wait_seconds": 540.0
}
```

> `queue_position` / `estimated_wait_seconds` 定义同 `POST /submit` 响应。仅在 `status=pending` 或 `processing` 时出现;`done` / `failed` 响应**不包含**这两个字段。

**完成成功**:
```json
{
  "job_id":       "a1b2c3d4e5f6...",
  "status":       "done",
  "workflow":     "pro",
  "created_at":   "2026-04-20T19:00:00+08:00",
  "completed_at": "2026-04-20T19:01:12+08:00",
  "result":       {"ok": true},
  "error":        null
}
```

**完成失败**:
```json
{
  "job_id":       "a1b2c3d4e5f6...",
  "status":       "failed",
  "workflow":     "pro",
  "created_at":   "2026-04-20T19:00:00+08:00",
  "completed_at": "2026-04-20T19:01:30+08:00",
  "result":       null,
  "error":        "处理失败,请稍后再试"
}
```

### Status 值

| status        | 说明                                      |
| ------------- | ----------------------------------------- |
| `pending`     | 等候排队处理                              |
| `processing`  | 正在处理                                  |
| `done`        | 成功(`result.ok = true`)                 |
| `failed`      | 失败(见 `error` 字段,已自动退款到该 workflow) |

### HTTP 状态码

| Status | 说明                        |
| ------ | --------------------------- |
| `200`  | 回 job 对象(含当前状态)   |
| `401`  | 未授权                      |
| `403`  | 此 job 不属于该 API Key     |
| `404`  | Job 不存在 / 已过 TTL(1 小时)清除 |

---

## DELETE /job/{job_id}

取消自己的 job。**只能取消 `pending` 状态**的 job,成功会自动退费(退到该 job 对应的 workflow 余额)。

已在 `processing` 阶段(服务端正在跑订阅流程)的 job 无法取消;`done` / `failed` 也无法取消(无意义)。

### Request

| 字段        | 位置   | 必填 | 说明                          |
| ----------- | ------ | ---- | ----------------------------- |
| `X-API-Key` | Header | ✓    | 创建该 job 时用的同一把 key   |

### Response — HTTP 200

```json
{
  "job_id":       "a1b2c3d4e5f6...",
  "status":       "failed",
  "workflow":     "pro",
  "created_at":   "2026-04-20T10:00:00+08:00",
  "completed_at": "2026-04-20T10:00:03+08:00",
  "result":       null,
  "error":        "cancelled"
}
```

### HTTP 状态码

| Status | 说明                                       |
| ------ | ------------------------------------------ |
| `200`  | 取消成功,已退费                           |
| `401`  | 未授权                                     |
| `403`  | 此 job 不属于该 API Key                    |
| `404`  | Job 不存在或已过期                         |
| `409`  | Job 已非 pending(processing/done/failed) |

---

## GET /balance

查询 API Key 在每个 workflow 的余额。

### Request

| 字段        | 位置   | 必填 | 说明               |
| ----------- | ------ | ---- | ------------------ |
| `X-API-Key` | Header | ✓    | 要查询的 API key   |

### Response — HTTP 200

```json
{
  "balances": {
    "plus": 42,
    "pro":  10
  }
}
```

`balances` 包含 server 上所有 workflow,即使该 workflow 余额为 0 也会回传(client 可以据此判断支持哪些 workflow)。

### HTTP 状态码

| Status | 说明      |
| ------ | --------- |
| `200`  | 回余额    |
| `401`  | 未授权    |

---

## GET /queue

查各 workflow 目前的队列状态与估算等待时间。回传的是**聚合数据**,不包含其他 client 的 job id 等敏感信息。

### Request

| 字段        | 位置   | 必填 | 说明               |
| ----------- | ------ | ---- | ------------------ |
| `X-API-Key` | Header | ✓    | 有效的 API key     |

### Response — HTTP 200

```json
{
  "queues": {
    "plus": {
      "pending":                      3,
      "processing":                   1,
      "workers":                      2,
      "avg_duration_seconds":         205.4,
      "estimated_next_wait_seconds":  513.5
    },
    "plus_1y": {
      "pending":                      0,
      "processing":                   0,
      "workers":                      1,
      "avg_duration_seconds":         180.0,
      "estimated_next_wait_seconds":  180.0
    },
    "pro": {
      "pending":                      1,
      "processing":                   0,
      "workers":                      1,
      "avg_duration_seconds":         247.1,
      "estimated_next_wait_seconds":  494.2
    },
    "pro_20x": {
      "pending":                      0,
      "processing":                   0,
      "workers":                      1,
      "avg_duration_seconds":         180.0,
      "estimated_next_wait_seconds":  180.0
    }
  }
}
```

### 字段说明

| 字段                          | 类型  | 说明                                                                 |
| ----------------------------- | ----- | -------------------------------------------------------------------- |
| `pending`                     | int   | 该 workflow 目前排队中的 job 数                                       |
| `processing`                  | int   | 该 workflow 目前正在处理的 job 数(上限 = `workers`)                 |
| `workers`                     | int   | 该 workflow 的并行处理数量。越大表示同时可处理的 job 越多,ETA 公式也会摊平 |
| `avg_duration_seconds`        | float | 最近 20 个完成 job 的平均处理秒数(纯处理时间,不含队列等候)。还没有历史样本 → fallback `180.0` |
| `estimated_next_wait_seconds` | float | 「现在送一个新 job 预估等多久完成」= `ceil((pending + processing + 1) / workers) * avg`。每个 avg 时段为一个 slot,N workers 并行每 slot 消化 N 个 job(不足 N 也占一整个 slot) |

> 所有字段皆为快照值,**估算值**仅供显示用(例如 UI 显示「plus 目前排队约 17 分钟」)。实际处理时间会依当下系统状况有所变动。
>
> 若要知道**自己某个具体 job** 的队列位置与 ETA,请用 `GET /job/{job_id}`,response 内有 `queue_position` 与 `estimated_wait_seconds`。

### HTTP 状态码

| Status | 说明      |
| ------ | --------- |
| `200`  | 回队列快照 |
| `401`  | 未授权    |

---

## 注意事项

### 1. 轮询策略

推荐使用 `?wait=30` 做 long-polling:
- 服务端在完成瞬间立即响应
- Client 不需短间隔 poll(节省带宽)
- 若 30 秒内未完成,回当前状态,client 可直接再打一次

不建议短于 2 秒的轮询频率。

### 2. Job 保留期限

完成的 job 在服务端保留 **1 小时**。超过后调用 `/job/{job_id}` 会回 `404`。请在 1 小时内取回结果。

### 3. Timeout 设定

- `POST /submit` 响应极快(< 1 秒),一般 timeout 10 秒即可
- `GET /job/{id}?wait=30` 建议 timeout 40 秒
- 整个 job 处理最长 **30 分钟**(1800 秒),超过 server 会将 job 标 `failed` 并自动退款。Client 端 polling 建议用 long-poll(`?wait=30`)而非自己 hold 一个 30 分钟连接

### 4. 扣费语义

- `POST /submit` 回 `202`:立即扣 1 点(从 `workflow` 对应的余额)
- Job 最终 `status = done`:扣款保留
- Job 最终 `status = failed`:**自动退款**到原 workflow,client 不需处理
- 各 workflow (`plus` / `plus_1y` / `pro` / `pro_20x`) 余额完全独立,扣 / 退都各自结算

### 5. 重试策略

| 场景                            | 建议动作                               |
| ------------------------------- | -------------------------------------- |
| `401`                           | 不要重试,修 API Key                   |
| `402`                           | 不要重试,充值对应 workflow 的余额     |
| `400 workflow 为必填`           | request body 补上 `workflow`           |
| `400 未知 workflow`             | 确认用 `"plus"` / `"plus_1y"` / `"pro"` / `"pro_20x"` |
| `400` 其他                      | 修正 request body 后才重试             |
| `503` (submit 时)              | 等 30-60 秒重试                        |
| Job `status = failed`           | 依 `error` 内容判断,通常可直接重新 submit |

### 6. 重复提交

同一个 access token 可多次调用 `/submit`,每次会独立建 job 各自扣费。请 client 端自行控制避免重复。

### 7. 并发

建议同一 API key **同 workflow 同时在途 job ≤ 5**。四个 workflow (`plus` / `plus_1y` / `pro` / `pro_20x`) 彼此独立队列,互不阻塞。

### 8. Workflow 选择

依想启用的订阅方案 + 期长选择:

| 目标订阅       | 用 workflow |
| -------------- | ----------- |
| Plus(1 个月)  | `plus`      |
| Plus(1 年)    | `plus_1y`   |
| Pro            | `pro`       |
| Pro(20x)      | `pro_20x`   |

Plus / Pro 都可直接从免费账号启用,Plus 不是 Pro 的前置条件。`plus` 与 `plus_1y` 为不同订阅期的 Plus 方案,`pro` 与 `pro_20x` 为不同变体的 Pro 方案,扣费 / 退款各自结算,请**依你想帮账号开通的方案**选择,送错不会自动转换。

---

## FAQ

**Q. `access_token` 从哪里获取?**
A. 登录 `chatgpt.com` 后,浏览器打开 `https://chatgpt.com/api/auth/session`,响应 JSON 内 `accessToken` 字段即是。

**Q. Access token 有效期?**
A. ChatGPT 侧 token 通常数小时内有效。建议获取后 1 小时内 submit。过期会收到 `400 请求参数无效`。

**Q. 如何确认订阅已生效?**
A. 收到 `status = done` 后,以该账号登录 ChatGPT 查看 Plus / Pro 状态。建议等 30 秒再检查。

**Q. Job 太久才完成怎么办?**
A. 单一 job 最长处理 30 分钟,超过会 `status = failed` + error `队列超时,请稍后重试`,此时余额已自动退回对应 workflow。

**Q. 怎么知道 job 还要等多久?**
A. 调用 `GET /job/{job_id}`,在 `pending` / `processing` 状态下 response 会带 `queue_position` 与 `estimated_wait_seconds`。想看整体队列状况可用 `GET /queue`。两者皆为估算值,实际时间依当下系统状况可能会有差异。

**Q. `workflow` 可以省略吗?**
A. 不可以,`workflow` 为必填字段,没有预设值。请依账号状态自行决定送 `"plus"` / `"plus_1y"` / `"pro"` / `"pro_20x"`。

**Q. 同一个 API key 可以同时用 plus / plus_1y / pro / pro_20x 吗?**
A. 可以。四个 workflow 余额完全独立,扣费 / 退款也各自结算。通过 `GET /balance` 可查各 workflow 目前的余额。

---

## 版本记录

| 日期       | 变更                                                                       |
| ---------- | -------------------------------------------------------------------------- |
| 2026-04-24 | v5:新增 `pro_20x` workflow(Pro 20x 版本)                                |
| 2026-04-23 | v4:Job timeout 延长为 30 分钟;新增 `GET /queue` endpoint;`/submit` 与 `/job/{id}` 响应加上 `queue_position` 与 `estimated_wait_seconds`;`/queue` 响应加上 `workers` (workflow 的并行处理数);文档化 `plus_1y` workflow(Plus 1 年期) |
| 2026-04-20 | v3:新增 `pro` workflow,`workflow` 为必填,余额拆成 per-workflow (`balances`) |
| 2026-04-19 | v2:改为 async job 模式 + 新增 `/balance` endpoint                            |
| 2026-04-19 | v1:初版(已停用的同步模式)                                                 |
