# Architecture Decision Record

## Task Storage Approach

**Decision**: Use in-memory Map for task storage in V1

**Rationale**:
- No persistence requirement specified
- Simplicity over complexity for initial version
- Faster development iteration
- Easy to swap later if persistence becomes necessary

**Trade-offs**:
- Data lost on server restart (acceptable for V1)
- No multi-process scaling (not needed yet)

**Files affected**: src/task-store.js
