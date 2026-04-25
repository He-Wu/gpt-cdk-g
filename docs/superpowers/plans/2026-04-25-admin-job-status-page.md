# Admin Job Status Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a super-admin-only admin page that queries upstream job status by Job ID and shows the raw API response without reading or updating local redemption records.

**Architecture:** Add a new admin-only backend endpoint that validates the Job ID, proxies the upstream `/job/{jobId}` API with the configured server-side credentials, and returns the upstream status code and JSON payload without touching local record state. Extend `admin.html` with a dedicated `任务查询` page, super-admin-only navigation entries, and a small raw-JSON results panel that calls the new endpoint.

**Tech Stack:** Node.js, Express, vanilla HTML/CSS/JS, node:test

---

### Task 1: Add failing backend tests

**Files:**
- Modify: `tests/security.test.js`
- Test: `tests/security.test.js`

- [ ] **Step 1: Write the failing test**
Add tests that cover:
  - super admin can query `/api/admin/job-status/:jobId` and receive raw upstream JSON
  - sub admin receives forbidden for the same endpoint
  - local records are not updated by the admin-only job status query

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/security.test.js --test-name-pattern "super admin job status|sub admin cannot query admin job status|admin job status query does not update local records"`
Expected: FAIL because the endpoint does not exist yet.

- [ ] **Step 3: Write minimal implementation**
Add the new admin-only endpoint in `server.js` with upstream proxy-only behavior and no local record sync.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/security.test.js --test-name-pattern "super admin job status|sub admin cannot query admin job status|admin job status query does not update local records"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/security.test.js server.js
git commit -m "feat: add admin upstream job status endpoint"
```

### Task 2: Add failing admin page tests

**Files:**
- Modify: `tests/security.test.js`
- Modify: `admin.html`
- Test: `tests/security.test.js`

- [ ] **Step 1: Write the failing test**
Add tests that assert:
  - the admin page includes a `page-job-status` section
  - the admin page includes `/api/admin/job-status/`
  - the admin page includes `loadAdminJobStatus`
  - the admin page marks the page/nav with `data-permission="manage_settings"` to keep it super-admin-only

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/security.test.js --test-name-pattern "admin page exposes a super-admin job status page"`
Expected: FAIL because the page is not present yet.

- [ ] **Step 3: Write minimal implementation**
Add desktop/mobile nav items, a dedicated page panel, and the frontend query/render logic in `admin.html`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/security.test.js --test-name-pattern "admin page exposes a super-admin job status page"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/security.test.js admin.html
git commit -m "feat: add admin job status page"
```

### Task 3: Run focused regression verification

**Files:**
- Modify: `tests/security.test.js`
- Modify: `server.js`
- Modify: `admin.html`
- Test: `tests/security.test.js`

- [ ] **Step 1: Run focused verification**

Run: `node --test tests/security.test.js --test-name-pattern "super admin job status|sub admin cannot query admin job status|admin job status query does not update local records|admin page exposes a super-admin job status page|admin page script parses so login handlers are actually defined"`
Expected: PASS

- [ ] **Step 2: Review diffs for scope**

Run: `git diff --stat -- tests/security.test.js server.js admin.html`
Expected: only the new admin job status backend/frontend/test changes

- [ ] **Step 3: Commit**

```bash
git add tests/security.test.js server.js admin.html docs/superpowers/plans/2026-04-25-admin-job-status-page.md
git commit -m "feat: add super-admin upstream job status page"
```
