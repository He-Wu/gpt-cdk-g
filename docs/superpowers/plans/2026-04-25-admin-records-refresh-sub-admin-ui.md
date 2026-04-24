# Admin Records Refresh And Sub Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-side records refresh button and complete the previously requested sub-admin UI flow in `admin.html`.

**Architecture:** Keep the existing backend sub-admin/session APIs in `server.js` and complete the missing frontend integration in `admin.html`. Drive visibility and page access from `/api/admin/me`, add a small accounts page for super admins, and reuse the existing records loader for the refresh action.

**Tech Stack:** Static HTML/CSS/JS admin page, Express backend, Node test runner

---

### Task 1: Lock Expected UI Behavior With Tests

**Files:**
- Modify: `tests/security.test.js`
- Test: `tests/security.test.js`

- [ ] **Step 1: Write the failing tests**

Add assertions for:
- records page refresh button markup and `loadRecords()` wiring
- login username input for sub-admin login
- account management page/container, loader, create action, and `/api/admin/me` usage

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/security.test.js --test-name-pattern "admin records page exposes a refresh button wired to reload current filters|admin page exposes username login and sub admin account management ui"`
Expected: FAIL because the refresh button and account UI are not fully present yet

- [ ] **Step 3: Write minimal implementation**

Implement only the HTML/JS needed to satisfy the new expectations without changing unrelated admin areas.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/security.test.js --test-name-pattern "admin records page exposes a refresh button wired to reload current filters|admin page exposes username login and sub admin account management ui"`
Expected: PASS

### Task 2: Complete Admin Login And Viewer State

**Files:**
- Modify: `admin.html`
- Test: `tests/security.test.js`

- [ ] **Step 1: Write the failing test**

Use the existing HTML assertions to require:
- `id="loginUsername"`
- `/api/admin/me`
- `currentViewer`

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/security.test.js --test-name-pattern "admin page exposes username login and sub admin account management ui|admin page renders creator usernames in cards and records tables"`
Expected: FAIL because viewer state and UI hooks are missing

- [ ] **Step 3: Write minimal implementation**

Add:
- username field to login form
- viewer state bootstrap via `/api/admin/me`
- permission-aware page/nav visibility and labels
- username rendering in card and record tables

- [ ] **Step 4: Run test to verify it passes**

Run the same command and expect PASS

### Task 3: Add Accounts Page And Sub Admin Operations

**Files:**
- Modify: `admin.html`
- Test: `tests/security.test.js`

- [ ] **Step 1: Write the failing test**

Use the existing HTML assertions to require:
- `page-accounts`
- `loadSubAdmins`
- `createSubAdminAccount`
- `/api/admin/sub-admins`

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/security.test.js --test-name-pattern "admin page exposes username login and sub admin account management ui|admin page preserves readable chinese copy for core ui labels"`
Expected: FAIL because the accounts page is missing

- [ ] **Step 3: Write minimal implementation**

Add a super-admin-only accounts page with:
- create form
- list rendering
- reset password and enable/disable actions

- [ ] **Step 4: Run test to verify it passes**

Run the same command and expect PASS

### Task 4: Add Records Refresh And Diagnostics Actions

**Files:**
- Modify: `admin.html`
- Test: `tests/security.test.js`

- [ ] **Step 1: Write the failing test**

Use:
- a new refresh-button assertion
- the existing `showRecordDiagnostics` assertion

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/security.test.js --test-name-pattern "admin records page exposes a refresh button wired to reload current filters|admin records expose manual review diagnostic actions"`
Expected: FAIL because both hooks are missing

- [ ] **Step 3: Write minimal implementation**

Add:
- refresh button calling `loadRecords()`
- diagnostic action/button for manual-review rows
- a small modal/alert-based diagnostics renderer using existing record fields

- [ ] **Step 4: Run test to verify it passes**

Run the same command and expect PASS

### Task 5: Final Verification

**Files:**
- Modify: `admin.html`
- Modify: `tests/security.test.js`

- [ ] **Step 1: Run focused test set**

Run: `node --test tests/security.test.js --test-name-pattern "admin records page exposes a refresh button wired to reload current filters|admin page exposes username login and sub admin account management ui|admin page renders creator usernames in cards and records tables|admin records expose manual review diagnostic actions|admin page script parses so login handlers are actually defined"`
Expected: PASS

- [ ] **Step 2: Run script parse smoke test**

Run:
```powershell
@'
const fs = require('fs');
const html = fs.readFileSync('admin.html', 'utf8');
const match = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
if (!match) throw new Error('admin script not found');
new Function(match[1]);
console.log('admin script parse ok');
'@ | node -
```

Expected: `admin script parse ok`

