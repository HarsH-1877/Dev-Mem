import express from 'express';
import { TaskStore } from './task-store.js';

const app = express();
const store = new TaskStore();

app.use(express.json());

// GET /tasks - List all tasks
app.get('/tasks', (req, res) => {
  res.json(store.list());
});

// POST /tasks - Create new task
app.post('/tasks', (req, res) => {
  const task = store.create(req.body);
  res.status(201).json(task);
});

// GET /tasks/:id - Get single task
app.get('/tasks/:id', (req, res) => {
  const task = store.read(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json(task);
});

// PUT /tasks/:id - Update task
app.put('/tasks/:id', (req, res) => {
  const task = store.update(req.params.id, req.body);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json(task);
});

// DELETE /tasks/:id - Delete task
app.delete('/tasks/:id', (req, res) => {
  const deleted = store.delete(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.status(204).send();
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Task API listening on port ${PORT}`);
});
