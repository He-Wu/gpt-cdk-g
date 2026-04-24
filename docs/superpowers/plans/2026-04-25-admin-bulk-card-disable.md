# Admin Bulk Card Disable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add batch card status actions in the admin cards page using both table selection and pasted card-code input.

**Architecture:** Reuse the existing `/api/admin/cards/disable` and `/api/admin/cards/enable` backend routes, and complete the missing admin-side UI in `admin.html`. Keep all status-management controls hidden for sub-admins by reusing the current permission checks.

**Tech Stack:** Static HTML/CSS/JS admin page, Express backend, Node test runner

---

### Task 1: Lock The UI Contract With Tests

**Files:**
- Modify: `tests/security.test.js`
- Test: `tests/security.test.js`

- [ ] **Step 1: Write the failing test**

Add assertions for:
- table row selection checkboxes and a select-all checkbox
- bulk action buttons for batch disable / enable
- bulk textarea input and handler function using existing admin card status endpoints

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/security.test.js --test-name-pattern "admin cards page exposes bulk selection and batch status actions"`
Expected: FAIL because the cards page does not expose the new controls yet

- [ ] **Step 3: Write minimal implementation**

Implement only the cards-page HTML/JS needed to satisfy the behavior and keep sub-admin restrictions intact.

- [ ] **Step 4: Run test to verify it passes**

Run the same command and expect PASS

### Task 2: Add Bulk Selection And Bulk Input Actions

**Files:**
- Modify: `admin.html`
- Test: `tests/security.test.js`

- [ ] **Step 1: Write the failing test**

Use the new HTML assertions to require:
- `cardsSelectAll`
- `toggleCardSelection`
- `applyBulkCardAction`
- `bulkCardActionInput`
- both `/api/admin/cards/disable` and `/api/admin/cards/enable`

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/security.test.js --test-name-pattern "admin cards page exposes bulk selection and batch status actions"`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Add:
- per-row checkbox rendering
- selected-card state and select-all handling
- buttons to batch disable / enable selected cards
- textarea-based batch input using the same action function

- [ ] **Step 4: Run test to verify it passes**

Run the same command and expect PASS

### Task 3: Final Verification

**Files:**
- Modify: `admin.html`
- Modify: `tests/security.test.js`

- [ ] **Step 1: Run focused test set**

Run: `node --test tests/security.test.js --test-name-pattern "admin cards page exposes bulk selection and batch status actions|admin page script parses so login handlers are actually defined"`
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

