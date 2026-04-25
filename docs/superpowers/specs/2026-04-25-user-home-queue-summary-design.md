# User Home Queue Summary Design

**Date:** 2026-04-25

## Goal

在用户首页接入上游 `GET /queue` 聚合接口，在卡密验证成功后展示当前 workflow 的队伍数量与预计等待时间，帮助用户在提交兑换前预估排队情况。

## Existing Context

- 用户首页已有单个任务的排队展示，来源是 `queue_position` 和 `estimated_wait_seconds`。
- 服务端已有上游 `GET /job/:jobId` 代理，但没有公开的 `/queue` 代理。
- 卡密验证成功后，前端已经拿到 `verifiedCard.type`，可直接作为 workflow 选择依据。

## Proposed Design

### Backend

- 新增 `GET /api/card/queue`。
- 服务端读取已配置的 `baseUrl` 和 `apiKey`，请求上游 `${baseUrl}/queue`。
- 允许前端通过 `workflow` 查询参数传入当前卡种，仅返回完整上游数据中的对应 workflow 摘要，或在前端自行筛选也可；优先保持响应简单稳定。
- 若系统未配置上游，返回 `503`；若上游异常，透传合理状态并返回安全错误信息。

### Frontend

- 在首页第二步卡片顶部，新增一个轻量摘要区。
- 卡密验证成功后，根据 `verifiedCard.type` 调用 `/api/card/queue?workflow=<type>`。
- 显示：
  - 当前队伍数量：取对应 workflow 的 `pending`
  - 预计等待时间：取 `estimated_next_wait_seconds`，按秒/分钟格式化
- 获取失败或缺少数据时隐藏摘要区，不阻塞验证和兑换。
- 重试兑换重新验证成功时刷新摘要；重置表单时清空摘要。

## Error Handling

- 上游不可用：前端静默隐藏摘要，不弹窗。
- workflow 无对应队列：隐藏摘要。
- 数据格式异常：视为无摘要，避免影响主流程。

## Testing

- 后端测试：验证 `/api/card/queue` 会携带 `X-API-Key` 正确代理上游并按 workflow 返回结果。
- 前端静态测试：验证首页包含队列摘要展示元素、格式化方法和 `/api/card/queue` 调用入口。
