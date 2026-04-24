# Admin Records Date Range Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add start-date and end-date filtering to the admin redemption-records page.

**Architecture:** Extend the existing `/api/admin/records` query parameters with `date_from` and `date_to`, and wire two date inputs into the current records filter bar in `admin.html`. Filtering should be inclusive by day and continue to work with the existing status, type, search, and pagination filters.

**Tech Stack:** Static HTML/CSS/JS admin page, Express backend, Node test runner

---

### Task 1: Lock Expected Backend And UI Behavior

**Files:**
- Modify: `tests/security.test.js`
- Test: `tests/security.test.js`

- [ ] **Step 1: Write the failing tests**

Add assertions for:
- `/api/admin/records` supporting `date_from` and `date_to`
- admin records filter bar exposing `recordsDateFrom` and `recordsDateTo`
- `loadRecords()` passing both date params through `URLSearchParams`

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/security.test.js --test-name-pattern "admin records support inclusive date range filtering|admin records page exposes date range filters wired to records api"`
Expected: FAIL because neither the backend nor the UI currently supports date filtering

- [ ] **Step 3: Write minimal implementation**

Implement only the date-range behavior needed to satisfy the tests without changing unrelated record logic.

- [ ] **Step 4: Run test to verify it passes**

Run the same command and expect PASS

### Task 2: Add Backend Inclusive Date Filtering

**Files:**
- Modify: `server.js`
- Test: `tests/security.test.js`

- [ ] **Step 1: Write the failing test**

Use a records fixture with multiple `created_at` values and assert:
- `date_from` excludes earlier records
- `date_to` includes records on the same day
- combining both returns only the in-range records

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/security.test.js --test-name-pattern "admin records support inclusive date range filtering"`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Add:
- a small helper to parse stored record timestamps
- inclusive start/end-of-day range filtering in `/api/admin/records`

- [ ] **Step 4: Run test to verify it passes**

Run the same command and expect PASS

### Task 3: Add Admin Records Date Inputs

**Files:**
- Modify: `admin.html`
- Test: `tests/security.test.js`

- [ ] **Step 1: Write the failing test**

Require:
- `id="recordsDateFrom"`
- `id="recordsDateTo"`
- `params.set('date_from', dateFrom)` and `params.set('date_to', dateTo)`

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/security.test.js --test-name-pattern "admin records page exposes date range filters wired to records api"`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Add the two inputs to the records filter bar and send them through `loadRecords()`.

- [ ] **Step 4: Run test to verify it passes**

Run the same command and expect PASS

### Task 4: Final Verification

**Files:**
- Modify: `server.js`
- Modify: `admin.html`
- Modify: `tests/security.test.js`

- [ ] **Step 1: Run focused test set**

Run: `node --test tests/security.test.js --test-name-pattern "admin records support inclusive date range filtering|admin records page exposes date range filters wired to records api|admin page script parses so login handlers are actually defined"`
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

