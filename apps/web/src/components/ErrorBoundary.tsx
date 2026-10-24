import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, ErrorState } from './ui';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Without a boundary, any render error unmounts the whole tree and leaves a
 * white screen that only a manual reload recovers from. One boundary below the
 * shell keeps navigation usable; the failing page shows a reload action.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] render error', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-start gap-3 p-2">
          <ErrorState message={`页面渲染出错：${this.state.error.message}`} />
          <Button variant="secondary" onClick={() => window.location.reload()}>
            刷新页面
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
