import { randomUUID } from 'node:crypto';
import type { TaskInfo } from '@mcpanel/shared';

const MAX_AGE_MS = 60 * 60 * 1000;

export class TaskTracker {
  private readonly tasks = new Map<string, TaskInfo>();
  private sink: ((task: TaskInfo) => void) | null = null;

  setSink(sink: (task: TaskInfo) => void): void {
    this.sink = sink;
  }

  start(kind: TaskInfo['kind'], instanceId: string): TaskInfo {
    const task: TaskInfo = {
      id: randomUUID(),
      kind,
      instanceId,
      status: 'running',
      progress: 0,
      message: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.tasks.set(task.id, task);
    this.publish(task);
    return task;
  }

  update(id: string, patch: Partial<Pick<TaskInfo, 'progress' | 'message'>>): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return;
    Object.assign(task, patch);
    this.publish(task);
  }

  finish(id: string, status: 'success' | 'failed', message: string | null = null): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = status;
    task.message = message;
    task.progress = status === 'success' ? 1 : task.progress;
    task.finishedAt = new Date().toISOString();
    this.publish(task);
  }

  get(id: string): TaskInfo | null {
    return this.tasks.get(id) ?? null;
  }

  cleanup(now = Date.now()): void {
    for (const [id, task] of this.tasks) {
      const reference = task.finishedAt ?? task.startedAt;
      if (now - new Date(reference).getTime() > MAX_AGE_MS) this.tasks.delete(id);
    }
  }

  private publish(task: TaskInfo): void {
    this.sink?.({ ...task });
  }
}
