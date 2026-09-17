# Evaluation Task Sequence

This file defines the exact sequence of 12 interdependent tasks used to evaluate Dev-Mem.

## Task 1: Initial Architecture Decision
**Objective**: Decide between in-memory store vs SQLite database for task storage.

**Expected outcome**: 
- Decision node: "Use in-memory Map for task storage in V1 due to simplicity and no persistence requirement"
- Files: `docs/architecture.md` created

**Expected agent action**: Create architecture doc stating the decision and rationale.

---

## Task 2: Failed Approach - Direct SQLite Implementation
**Objective**: Try to implement SQLite directly (this SHOULD fail).

**Expected outcome**:
- FailedApproach node: "Direct SQLite implementation failed - violates simplicity constraint from architecture decision"
- Files: `src/store-sqlite.js` (attempted, then removed)

**Expected agent action**: Attempt SQLite, encounter issue, recognize conflict with Task 1 decision, abandon and document.

---

## Task 3: Implement In-Memory Store
**Objective**: Create the task store using in-memory Map (aligned with Task 1 decision).

**Expected outcome**:
- Discovery node: "Task store interface requires create, read, update, delete, and list operations"
- Files: `src/task-store.js` created

**Expected agent action**: Implement TaskStore class with Map-based storage and CRUD methods.

---

## Task 4: Add REST API Endpoints
**Objective**: Create Express server with REST endpoints for task CRUD operations.

**Expected outcome**:
- Convention node: "REST endpoints follow pattern: GET /tasks, POST /tasks, GET /tasks/:id, PUT /tasks/:id, DELETE /tasks/:id"
- Files: `src/server.js`, `src/routes.js` created

**Expected agent action**: Implement Express server using TaskStore from Task 3.

---

## Task 5: Discovery - Error Handling Pattern
**Objective**: While testing endpoints, discover and document the error handling pattern that should be used.

**Expected outcome**:
- Discovery node: "All route handlers should use try-catch with consistent JSON error format: {error: string, code: string}"
- Files: `src/routes.js` modified

**Expected agent action**: Add error handling to one endpoint and document the pattern discovered.

---

## Task 6: Apply Error Handling Convention
**Objective**: Apply the error handling pattern from Task 5 to all remaining endpoints.

**Expected outcome**:
- Convention node: "All API endpoints must wrap logic in try-catch with {error, code} JSON format"
- Files: `src/routes.js` modified

**Expected agent action**: WITHOUT Dev-Mem, agent rediscovers error pattern. WITH Dev-Mem, agent retrieves Task 5 discovery and applies consistently.

---

## Task 7: Re-attempt SQLite (Regression Test)
**Objective**: Try SQLite again for persistence (this should trigger regression intelligence).

**Expected outcome**:
- FailedApproach node: "SQLite persistence re-attempted but conflicts with in-memory architecture decision"
- Regression Intelligence warning surfaced from Task 2

**Expected agent action**: WITHOUT Dev-Mem, agent attempts SQLite again, fails again. WITH Dev-Mem, Regression Intelligence warns about Task 2's failed attempt.

---

## Task 8: Establish Validation Convention
**Objective**: Choose and document input validation approach (use simple manual validation, not a library).

**Expected outcome**:
- Convention node: "Input validation uses manual checks (typeof, required fields) without external validation libraries"
- Constraint node: "Keep dependencies minimal - avoid validation libraries for this simple API"
- Files: `docs/conventions.md` created

**Expected agent action**: Document validation convention and add to one endpoint.

---

## Task 9: Add Input Validation
**Objective**: Add validation to all POST/PUT endpoints following Task 8 convention.

**Expected outcome**:
- Discovery node: "Tasks require: title (string, non-empty), completed (boolean, optional, defaults to false)"
- Files: `src/routes.js` modified

**Expected agent action**: WITHOUT Dev-Mem, agent might choose different validation approach. WITH Dev-Mem, agent retrieves Task 8 convention and applies consistently.

---

## Task 10: Identify Missing Feature
**Objective**: Recognize and document that authentication is missing.

**Expected outcome**:
- OpenIssue node: "No authentication layer - all endpoints are publicly accessible"
- Files: `docs/architecture.md` updated

**Expected agent action**: Document the security gap as an open issue.

---

## Task 11: Add Simple Authentication
**Objective**: Implement basic API key authentication (resolves Task 10).

**Expected outcome**:
- Decision node: "Use API key in Authorization header for authentication"
- Files: `src/auth.js`, `src/server.js` modified
- Edge: resolves Task 10 OpenIssue

**Expected agent action**: WITHOUT Dev-Mem, might not recall Task 10 issue. WITH Dev-Mem, explicitly resolves the documented open issue.

---

## Task 12: Refactor for Consistency
**Objective**: Final refactor applying all established conventions (error handling, validation, auth).

**Expected outcome**:
- Convention node: "All endpoints must: 1) authenticate, 2) validate input, 3) handle errors consistently"
- Files: `src/routes.js` refactored

**Expected agent action**: WITHOUT Dev-Mem, rediscovers each pattern. WITH Dev-Mem, retrieves all conventions from Tasks 5, 8, 11 and applies systematically.

---

## Measurement Points

### Redundant Discovery
- Task 6 should retrieve error handling discovery from Task 5
- Task 9 should retrieve validation convention from Task 8
- Task 11 should retrieve open issue from Task 10
- Task 12 should retrieve all conventions from Tasks 5, 8, 11

### Regression Intelligence
- Task 7 should surface FailedApproach from Task 2

### Constraint Awareness
- Task 7 should respect architecture Decision from Task 1
- Task 9 should respect validation Constraint from Task 8

### Success Rate
- Tasks should complete faster and more correctly with Dev-Mem active
