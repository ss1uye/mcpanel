import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MetricsSparkline } from '../src/components/MetricsSparkline';

describe('MetricsSparkline', () => {
  it('renders a lightweight SVG polyline', () => {
    const { container } = render(<MetricsSparkline values={[1, 4, 2, 8]} />);
    const polyline = container.querySelector('polyline');
    expect(polyline).not.toBeNull();
    expect(polyline?.getAttribute('points')?.split(' ')).toHaveLength(4);
  });

  it('waits for two samples', () => {
    const { getByText } = render(<MetricsSparkline values={[1]} />);
    expect(getByText('等待采样…')).toBeTruthy();
  });
});
