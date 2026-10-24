function hashName(name: string): number {
  let hash = 2166136261;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function PlayerAvatar({ name, size = 28 }: { name: string; size?: number }) {
  const hash = hashName(name);
  const hue = hash % 360;
  const cells = Array.from({ length: 25 }, (_value, index) => {
    const row = Math.floor(index / 5);
    const column = index % 5;
    const mirrored = column > 2 ? row * 5 + (4 - column) : index;
    return ((hash >> (mirrored % 24)) & 1) === 1;
  });
  return (
    <div
      className="grid shrink-0 grid-cols-5 gap-px overflow-hidden rounded"
      style={{ width: size, height: size, backgroundColor: `hsl(${hue} 45% 18%)` }}
      aria-hidden="true"
    >
      {cells.map((filled, index) => (
        <span key={index} style={{ backgroundColor: filled ? `hsl(${hue} 65% 55%)` : 'transparent' }} />
      ))}
    </div>
  );
}
