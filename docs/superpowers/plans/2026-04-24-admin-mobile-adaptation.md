# Admin Mobile Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin page fully usable on phones for navigation, card generation, filtering, and per-row actions without breaking the desktop layout.

**Architecture:** Keep the existing single-file `admin.html` structure and add a mobile-only navigation layer plus responsive layout rules. Reuse the current page switching logic so desktop and mobile stay on the same navigation state while mobile gets larger touch targets and scroll-safe data tables.

**Tech Stack:** Static HTML, CSS, vanilla JavaScript, Node test runner

---

### Task 1: Add mobile admin navigation

**Files:**
- Modify: `admin.html`
- Test: `tests/security.test.js`

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run it to verify the test fails**
- [ ] **Step 3: Add a mobile top bar, drawer/overlay nav, and JS helpers for opening/closing/updating mobile navigation**
- [ ] **Step 4: Run the targeted test to verify it passes**

### Task 2: Make core admin layouts usable on phones

**Files:**
- Modify: `admin.html`
- Test: `tests/security.test.js`

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run it to verify the test fails**
- [ ] **Step 3: Add responsive CSS for stats grid, form rows, filter bars, pagination, buttons, generated code actions, and table wrappers**
- [ ] **Step 4: Run the targeted test to verify it passes**

### Task 3: Verify the full admin experience regression surface

**Files:**
- Modify: `tests/security.test.js` (if needed)
- Verify: `admin.html`, `index.html`

- [ ] **Step 1: Run syntax checks for the updated frontend scripts**
- [ ] **Step 2: Run the full regression suite**
- [ ] **Step 3: Confirm desktop-oriented admin tests still pass**
