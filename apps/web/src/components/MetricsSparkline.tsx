import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts';

export function MetricsSparkline({ values, height = 40 }: { values: number[]; height?: number }) {
  const data = values.map((value, index) => ({ index, value }));
  if (data.length < 2) {
    return <div className="flex h-10 items-center text-xs text-[var(--muted)]">等待采样…</div>;
  }
  return (
    <div style={{ height }} aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <YAxis hide domain={['dataMin', 'dataMax']} />
          <Line type="monotone" dataKey="value" stroke="var(--primary)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
