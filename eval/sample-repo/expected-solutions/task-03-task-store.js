// In-memory task store implementation
export class TaskStore {
  constructor() {
    this.tasks = new Map();
    this.nextId = 1;
  }

  create(taskData) {
    const id = String(this.nextId++);
    const task = {
      id,
      title: taskData.title,
      completed: taskData.completed || false,
      createdAt: new Date().toISOString()
    };
    this.tasks.set(id, task);
    return task;
  }

  read(id) {
    return this.tasks.get(id) || null;
  }

  update(id, updates) {
    const task = this.tasks.get(id);
    if (!task) return null;
    
    const updated = { ...task, ...updates, id };
    this.tasks.set(id, updated);
    return updated;
  }

  delete(id) {
    return this.tasks.delete(id);
  }

  list() {
    return Array.from(this.tasks.values());
  }
}
