# User Home Queue Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在用户首页展示当前 workflow 的队伍数量与预计等待时间。

**Architecture:** 服务端新增一个安全的 `/api/card/queue` 代理，前端在卡密验证成功后按卡种拉取对应 workflow 队列摘要并渲染到第二步卡片中。失败时仅隐藏摘要，不影响兑换主流程。

**Tech Stack:** Node.js, Express, 原生 HTML/CSS/JavaScript, node:test

---

### Task 1: Lock Backend Queue Proxy Behavior

**Files:**
- Modify: `tests/security.test.js`
- Modify: `server.js`

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run the targeted test and verify it fails for missing `/api/card/queue`**
- [ ] **Step 3: Implement minimal `/api/card/queue` proxy**
- [ ] **Step 4: Run the targeted test and verify it passes**

### Task 2: Lock Homepage Queue Summary Hooks

**Files:**
- Modify: `tests/security.test.js`
- Modify: `index.html`

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run the targeted HTML test and verify it fails before homepage changes**
- [ ] **Step 3: Add homepage queue summary UI and fetch/format logic**
- [ ] **Step 4: Run the targeted HTML test and verify it passes**

### Task 3: Verify End-to-End Regression Safety

**Files:**
- Modify: `tests/security.test.js` (reuse)
- Modify: `server.js`
- Modify: `index.html`

- [ ] **Step 1: Run the targeted queue-related tests**
- [ ] **Step 2: Review outputs for proxy behavior and homepage exposure**
- [ ] **Step 3: Report verified results and any remaining gaps**
