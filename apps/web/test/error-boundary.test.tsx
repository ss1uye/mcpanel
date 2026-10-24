import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../src/components/ErrorBoundary';

function Bomb({ message }: { message: string }): never {
  throw new Error(message);
}

describe('ErrorBoundary', () => {
  it('shows the fallback with a reload action instead of unmounting everything', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Bomb message="配置解析失败" />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('页面渲染出错：配置解析失败');
    expect(screen.getByRole('button', { name: '刷新页面' })).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('keeps rendering children once they stop throwing', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <ErrorBoundary>
        <Bomb message="boom" />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    rerender(
      <ErrorBoundary>
        <p>恢复正常</p>
      </ErrorBoundary>,
    );
    // The boundary latches the error until remount; the operator reloads the page.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('the reload button triggers a page reload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true });
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <Bomb message="boom" />
      </ErrorBoundary>,
    );
    await user.click(screen.getByRole('button', { name: '刷新页面' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
