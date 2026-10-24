import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PlayerList } from '../src/components/PlayerList';

function renderList(onAction = vi.fn(async () => undefined)) {
  render(<PlayerList players={['Steve', 'Alex']} onAction={onAction} />);
  return onAction;
}

describe('PlayerList', () => {
  it('renders one row per player and sends an OP action', async () => {
    const onAction = renderList();
    expect(screen.getByText('Steve')).toBeInTheDocument();
    expect(screen.getByText('Alex')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: '玩家操作' })[0]!);
    await user.click(screen.getByRole('menuitem', { name: '设为 OP' }));

    expect(onAction).toHaveBeenCalledWith({ action: 'op', player: 'Steve' });
  });

  it('asks for a reason before kicking', async () => {
    const onAction = renderList();
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: '玩家操作' })[0]!);
    await user.click(screen.getByRole('menuitem', { name: '踢出' }));
    await user.type(screen.getByLabelText('原因'), '挂机');
    await user.click(screen.getByRole('button', { name: '确认踢出' }));

    expect(onAction).toHaveBeenCalledWith({ action: 'kick', player: 'Steve', reason: '挂机' });
  });

  it('offers the gamemode picker', async () => {
    const onAction = renderList();
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: '玩家操作' })[1]!);
    await user.click(screen.getByRole('menuitem', { name: '切换游戏模式' }));
    await user.selectOptions(screen.getByLabelText('游戏模式'), 'creative');
    await user.click(screen.getByRole('button', { name: '确认切换' }));

    expect(onAction).toHaveBeenCalledWith({ action: 'gamemode', player: 'Alex', mode: 'creative' });
  });
});
