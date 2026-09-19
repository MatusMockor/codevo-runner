import type { TaskRepository, TaskApplication, SubagentLifecycleDetail } from './ports.js';
import { legacyAgentSubagentLifecycle } from '../domain/subagent-lifecycle.js';
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
  async events(id: string, after: number, detail: SubagentLifecycleDetail = 'legacy') {
    const page = await this.repository.listEvents(validateId(id), validateCursor(after));
    if (detail === 'retained' || page.subagentLifecycle === undefined) return page;
    return { ...page, subagentLifecycle: legacyAgentSubagentLifecycle(page.subagentLifecycle) };
  }
}
