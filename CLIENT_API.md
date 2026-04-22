# API 文件

## 概述

本服務為 ChatGPT 帳號啟用 **Plus** 或 **Pro** 訂閱。採用**非同步 Job 模式**:提交後伺服端立即回 `job_id`,client 透過 `/job/{job_id}` 查詢結果。

## 基本資訊

| 項目         | 值                          |
| ------------ | --------------------------- |
| Base URL     | `https://<your-domain>`     |
| 認證         | Header `X-API-Key`          |
| Content-Type | `application/json`          |

每個 API key 對 **每個 workflow 各有獨立餘額**(`balances.plus` / `balances.pro`)。提交時 client 必須指定 `workflow`,server 會扣對應 workflow 的餘額;成功扣 1 點,失敗自動退回該 workflow。

## Workflows

API 提供兩個 workflow,對應不同訂閱方案:

| name   | 用途                       |
| ------ | -------------------------- |
| `plus` | 啟用 ChatGPT Plus 訂閱     |
| `pro`  | 啟用 ChatGPT Pro 訂閱      |

每個 API Key 對每個 workflow **各有獨立餘額**(`balances.plus` / `balances.pro`)。提交時 `workflow` 為必填。

---

## 使用流程

```
┌─────────────┐    ┌────────────────┐    ┌──────────────────────┐
│ POST /submit│ ─▶ │ 回 202 job_id  │ ─▶ │ GET /job/{job_id}    │
└─────────────┘    └────────────────┘    │ (建議加 ?wait=30)    │
                                          └────────┬─────────────┘
                                                   ▼
                                         status = done / failed

 [可選] DELETE /job/{job_id} — 取消 pending 的 job,自動退費
 [可選] GET    /balance     — 查 API Key 各 workflow 餘額
```

**建議**: `GET /job/{job_id}?wait=30` 使用 long-polling,伺服端會 block 最多 30 秒直到 job 完成或 timeout,大幅減少輪詢次數。

---

## POST /submit

建立啟用 job,立即返回 `job_id`。不會阻塞等待實際處理。

### Request

| 欄位            | 位置   | 必填 | 說明                                          |
| --------------- | ------ | ---- | --------------------------------------------- |
| `X-API-Key`     | Header | ✓    | 分配給你的 API key                            |
| `access_token`  | Body   | ✓    | ChatGPT 使用者的 access token                 |
| `workflow`      | Body   | ✓    | `"plus"` 或 `"pro"`,決定走哪條訂閱流程       |

#### Request 範例

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIs...",
  "workflow":     "pro"
}
```

### Response

#### 成功建立 — HTTP 202

```json
{
  "job_id":   "a1b2c3d4e5f6...",
  "workflow": "pro",
  "status":   "pending"
}
```

#### 失敗 — HTTP 4xx / 5xx

```json
{
  "detail": "<錯誤訊息>"
}
```

### HTTP 狀態碼

| Status | 說明                                                 | 扣費 |
| ------ | ---------------------------------------------------- | ---- |
| `202`  | Job 建立成功,進入排隊處理                           | 扣 1 (該 workflow 餘額) |
| `400`  | 請求參數無效 (含 `workflow` 為必填、不認得的 workflow) | 不扣 |
| `401`  | 未授權 (API Key 無效)                                | 不扣 |
| `402`  | 餘額不足 (該 workflow 餘額為 0,訊息含 workflow 名)  | 不扣 |
| `503`  | 服務暫停中                                           | 不扣 |

---

## GET /job/{job_id}

查詢 job 狀態。支援 long-polling 減少輪詢壓力。

### Request

| 欄位        | 位置   | 必填 | 說明                                         |
| ----------- | ------ | ---- | -------------------------------------------- |
| `X-API-Key` | Header | ✓    | 建立該 job 時用的同一把 key                  |
| `wait`      | Query  | ✗    | Long-poll 秒數 (0-60,預設 0)。建議設 30  |

#### 範例

```
GET /job/a1b2c3d4e5f6?wait=30
```

### Response — HTTP 200

**仍處理中**:
```json
{
  "job_id":       "a1b2c3d4e5f6...",
  "status":       "pending",
  "workflow":     "pro",
  "created_at":   "2026-04-20T19:00:00+08:00",
  "completed_at": null,
  "result":       null,
  "error":        null
}
```

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

**完成失敗**:
```json
{
  "job_id":       "a1b2c3d4e5f6...",
  "status":       "failed",
  "workflow":     "pro",
  "created_at":   "2026-04-20T19:00:00+08:00",
  "completed_at": "2026-04-20T19:01:30+08:00",
  "result":       null,
  "error":        "處理失敗,請稍後再試"
}
```

### Status 值

| status        | 說明                                      |
| ------------- | ----------------------------------------- |
| `pending`     | 等候排隊處理                              |
| `processing`  | 正在處理                                  |
| `done`        | 成功(`result.ok = true`)                 |
| `failed`      | 失敗(見 `error` 欄位,已自動退款到該 workflow) |

### HTTP 狀態碼

| Status | 說明                        |
| ------ | --------------------------- |
| `200`  | 回 job 物件(含當前狀態)   |
| `401`  | 未授權                      |
| `403`  | 此 job 不屬於該 API Key     |
| `404`  | Job 不存在 / 已過 TTL(1 小時)清除 |

---

## DELETE /job/{job_id}

取消自己的 job。**只能取消 `pending` 狀態**的 job,成功會自動退費(退到該 job 對應的 workflow 餘額)。

已在 `processing` 階段(伺服端正在跑訂閱流程)的 job 無法取消;`done` / `failed` 也無法取消(無意義)。

### Request

| 欄位        | 位置   | 必填 | 說明                          |
| ----------- | ------ | ---- | ----------------------------- |
| `X-API-Key` | Header | ✓    | 建立該 job 時用的同一把 key   |

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

### HTTP 狀態碼

| Status | 說明                                       |
| ------ | ------------------------------------------ |
| `200`  | 取消成功,已退費                           |
| `401`  | 未授權                                     |
| `403`  | 此 job 不屬於該 API Key                    |
| `404`  | Job 不存在或已過期                         |
| `409`  | Job 已非 pending(processing/done/failed) |

---

## GET /balance

查詢 API Key 在每個 workflow 的餘額。

### Request

| 欄位        | 位置   | 必填 | 說明               |
| ----------- | ------ | ---- | ------------------ |
| `X-API-Key` | Header | ✓    | 要查詢的 API key   |

### Response — HTTP 200

```json
{
  "balances": {
    "plus": 42,
    "pro":  10
  }
}
```

`balances` 包含 server 上所有 workflow,即使該 workflow 餘額為 0 也會回傳(client 可以據此判斷支援哪些 workflow)。

### HTTP 狀態碼

| Status | 說明      |
| ------ | --------- |
| `200`  | 回餘額    |
| `401`  | 未授權    |

---

## 注意事項

### 1. 輪詢策略

推薦使用 `?wait=30` 做 long-polling:
- 伺服端在完成瞬間立即回應
- Client 不需短間隔 poll(節省頻寬)
- 若 30 秒內未完成,回當前狀態,client 可直接再打一次

不建議短於 2 秒的輪詢頻率。

### 2. Job 保留期限

完成的 job 在伺服端保留 **1 小時**。超過後呼叫 `/job/{job_id}` 會回 `404`。請在 1 小時內取回結果。

### 3. Timeout 設定

- `POST /submit` 回應極快(< 1 秒),一般 timeout 10 秒即可
- `GET /job/{id}?wait=30` 建議 timeout 40 秒
- 整個 job 處理最長 **5 分鐘**(300 秒),無需 client 端等這麼久

### 4. 扣費語意

- `POST /submit` 回 `202`:立即扣 1 點(從 `workflow` 對應的餘額)
- Job 最終 `status = done`:扣款保留
- Job 最終 `status = failed`:**自動退款**到原 workflow,client 不需處理
- Plus 與 Pro 餘額完全獨立,扣 / 退都各自結算

### 5. 重試策略

| 情境                            | 建議動作                               |
| ------------------------------- | -------------------------------------- |
| `401`                           | 不要重試,修 API Key                   |
| `402`                           | 不要重試,儲值對應 workflow 的餘額     |
| `400 workflow 為必填`           | request body 補上 `workflow`           |
| `400 未知 workflow`             | 確認用 `"plus"` 或 `"pro"`             |
| `400` 其它                      | 修正 request body 後才重試             |
| `503` (submit 時)              | 等 30-60 秒重試                        |
| Job `status = failed`           | 依 `error` 內容判斷,通常可直接重新 submit |

### 6. 重複提交

同一個 access token 可多次呼叫 `/submit`,每次會獨立建 job 各自扣費。請 client 端自行控制避免重複。

### 7. 併發

建議同一 API key **同 workflow 同時在途 job ≤ 5**。Plus 與 Pro 之間互不阻塞。

### 8. Workflow 選擇

依想啟用的訂閱方案選擇:

| 目標訂閱   | 用 workflow |
| ---------- | ----------- |
| Plus       | `plus`      |
| Pro        | `pro`       |

兩個 workflow 都可直接從免費帳號啟用,Plus 不是 Pro 的前置條件。

---

## FAQ

**Q. `access_token` 從哪裡取得?**
A. 登入 `chatgpt.com` 後,瀏覽器打開 `https://chatgpt.com/api/auth/session`,回應 JSON 內 `accessToken` 欄位即是。

**Q. Access token 有效期?**
A. ChatGPT 側 token 通常數小時內有效。建議取得後 1 小時內 submit。過期會收到 `400 請求參數無效`。

**Q. 如何確認訂閱已生效?**
A. 收到 `status = done` 後,以該帳號登入 ChatGPT 檢視 Plus / Pro 狀態。建議等 30 秒再檢查。

**Q. Job 太久才完成怎麼辦?**
A. 單一 job 最長處理 5 分鐘,超過會 `status = failed` + error `隊列超時,請稍後重試`,此時餘額已自動退回對應 workflow。

**Q. `workflow` 可以省略嗎?**
A. 不可以,`workflow` 為必填欄位,沒有預設值。請依帳號狀態自行決定送 `"plus"` 或 `"pro"`。

**Q. 同一個 API key 可以同時用 plus 和 pro 嗎?**
A. 可以。兩個 workflow 餘額完全獨立,扣費 / 退款也各自結算。透過 `GET /balance` 可查兩個 workflow 目前的餘額。

---

## 版本紀錄

| 日期       | 變更                                                                       |
| ---------- | -------------------------------------------------------------------------- |
| 2026-04-20 | v3:新增 `pro` workflow,`workflow` 為必填,餘額拆成 per-workflow (`balances`) |
| 2026-04-19 | v2:改為 async job 模式 + 新增 `/balance` endpoint                            |
| 2026-04-19 | v1:初版(已停用的同步模式)                                                 |
