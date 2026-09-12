import type { TaskRepository, TaskApplication } from './ports.js';
import { parseTaskInput, validateCursor, validateId } from '../domain/task-input.js';

/** Application use cases depend on repository capabilities, never SQLite or HTTP. */
export class TaskService implements TaskApplication {
  constructor(private readonly repository: TaskRepository) {}

  create(input: unknown) {
    return this.repository.createTask(parseTaskInput(input));
  }
  get(id: string) {
    return this.repository.getTask(validateId(id));
  }
  list(after: number) {
    return this.repository.listTasks(validateCursor(after));
  }
  cancel(id: string) {
    return this.repository.cancelTask(validateId(id));
  }
  events(id: string, after: number) {
    return this.repository.listEvents(validateId(id), validateCursor(after));
  }
}
