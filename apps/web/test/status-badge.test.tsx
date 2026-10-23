import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { INSTANCE_STATES } from '@mcpanel/shared';
import { StatusBadge } from '../src/components/StatusBadge';

describe('StatusBadge', () => {
  it('shows a distinct label for every state, not colour alone', () => {
    for (const state of INSTANCE_STATES) {
      const { unmount } = render(<StatusBadge state={state} />);
      expect(screen.getByText(/[\u4e00-\u9fa5]/)).toBeInTheDocument();
      unmount();
    }
  });

  it('labels running and orphaned distinctly', () => {
    const { rerender, unmount } = render(<StatusBadge state="running" />);
    expect(screen.getByText('运行中')).toBeInTheDocument();
    rerender(<StatusBadge state="orphaned" />);
    expect(screen.getByText('未接管')).toBeInTheDocument();
    rerender(<StatusBadge state="unknown" />);
    expect(screen.getByText('状态未知')).toBeInTheDocument();
    unmount();
  });
});
