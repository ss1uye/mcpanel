import { describe, expect, it } from 'vitest';
import { TaskTracker } from '../../src/services/task-tracker';

const TWO_HOURS = 2 * 60 * 60 * 1000;

describe('TaskTracker', () => {
  it('keeps a running task even after the cleanup age', () => {
    const tasks = new TaskTracker();
    const task = tasks.start('backup', 'instance-1');
    tasks.cleanup(Date.now() + TWO_HOURS);
    expect(tasks.get(task.id)).toMatchObject({ status: 'running' });
  });

  it('removes finished tasks after the retention window', () => {
    const tasks = new TaskTracker();
    const task = tasks.start('backup', 'instance-1');
    tasks.finish(task.id, 'success');
    tasks.cleanup(Date.now() + TWO_HOURS);
    expect(tasks.get(task.id)).toBeNull();
  });
});
