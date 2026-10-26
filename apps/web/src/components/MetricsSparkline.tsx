const VIEW_WIDTH = 100;
const PADDING = 2;

export function MetricsSparkline({ values, height = 40 }: { values: number[]; height?: number }) {
  if (values.length < 2) {
    return <div className="flex h-10 items-center text-xs text-[var(--muted)]">等待采样…</div>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const usableHeight = Math.max(1, height - PADDING * 2);
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * VIEW_WIDTH;
      const y = span === 0 ? height / 2 : height - PADDING - ((value - min) / span) * usableHeight;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  return (
    <div style={{ height }} aria-hidden="true">
      <svg className="h-full w-full" viewBox={`0 0 ${VIEW_WIDTH} ${height}`} preserveAspectRatio="none" role="presentation">
        <polyline
          points={points}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
