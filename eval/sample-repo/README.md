# Task Management API - Sample Repo for Dev-Mem Evaluation

This is a minimal task management REST API designed for evaluating Dev-Mem's ability to preserve development knowledge across sessions.

## Task Sequence Design

The 12 tasks below are specifically designed so that later tasks depend on knowledge from earlier ones:

1. **Task 1**: Initial architecture decision (in-memory store vs database)
2. **Task 2**: Failed approach attempting direct SQLite (will fail due to constraint)
3. **Task 3**: Implement in-memory task store (depends on Task 1 decision)
4. **Task 4**: Add REST endpoints (depends on Task 3's store interface)
5. **Task 5**: Discovery about error handling pattern
6. **Task 6**: Apply error handling convention to all endpoints (depends on Task 5)
7. **Task 7**: Attempt SQLite again (should trigger Regression Intelligence from Task 2)
8. **Task 8**: Establish validation convention using a specific library
9. **Task 9**: Add input validation to endpoints (depends on Task 8 convention)
10. **Task 10**: Open issue about missing authentication
11. **Task 11**: Add authentication (resolves Task 10 issue, depends on prior architecture)
12. **Task 12**: Refactor using established conventions (depends on Tasks 5, 8, 11)

## Expected Dev-Mem Benefits

- **Redundant discovery avoided**: Without Dev-Mem, a new session on Task 6 would need to re-discover the error handling pattern from Task 5
- **Regression prevention**: Task 7 should surface the failed SQLite attempt from Task 2
- **Constraint awareness**: Task 11 must respect the architecture decision from Task 1
- **Convention consistency**: Tasks 9 and 12 should apply conventions from Tasks 5 and 8
