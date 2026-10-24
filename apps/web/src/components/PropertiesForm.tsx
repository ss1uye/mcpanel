import type { PropertiesPayload } from '@mcpanel/shared';
import { Field, Input, Select } from './ui';

const BOOL_KEYS = new Set([
  'online-mode',
  'white-list',
  'enforce-whitelist',
  'hardcore',
  'pvp',
  'allow-flight',
  'force-gamemode',
  'enable-rcon',
  'enable-query',
  'allow-nether',
  'enable-command-block',
]);

const ENUM_OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
  gamemode: [
    { value: 'survival', label: '生存' },
    { value: 'creative', label: '创造' },
    { value: 'adventure', label: '冒险' },
    { value: 'spectator', label: '旁观' },
  ],
  difficulty: [
    { value: 'peaceful', label: '和平' },
    { value: 'easy', label: '简单' },
    { value: 'normal', label: '普通' },
    { value: 'hard', label: '困难' },
  ],
};

const GROUPS: Array<{ title: string; fields: string[] }> = [
  { title: '基础', fields: ['motd', 'server-port', 'max-players', 'online-mode', 'white-list', 'enforce-whitelist'] },
  {
    title: '玩法',
    fields: ['gamemode', 'difficulty', 'hardcore', 'pvp', 'allow-flight', 'spawn-protection', 'force-gamemode'],
  },
  { title: '性能', fields: ['view-distance', 'simulation-distance', 'max-tick-time', 'entity-broadcast-range-percentage'] },
  { title: '网络', fields: ['server-ip', 'enable-rcon', 'rcon.port', 'rcon.password', 'enable-query', 'query.port'] },
  {
    title: '世界',
    fields: ['level-name', 'level-seed', 'level-type', 'allow-nether', 'enable-command-block', 'op-permission-level'],
  },
];

const KNOWN_KEYS = new Set(GROUPS.flatMap((group) => group.fields));

function originalValues(payload: PropertiesPayload): Record<string, string> {
  const values: Record<string, string> = {};
  for (const entry of payload.entries) values[entry.key] = entry.value;
  return values;
}

export function isDirty(payload: PropertiesPayload, values: Record<string, string>): boolean {
  const original = originalValues(payload);
  return Object.entries(values).some(([key, value]) => original[key] !== value);
}

export function PropertiesForm({
  payload,
  values,
  onChange,
}: {
  payload: PropertiesPayload;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const set = (key: string, value: string) => onChange({ ...values, [key]: value });
  const extras = payload.entries.filter((entry) => !KNOWN_KEYS.has(entry.key));

  return (
    <div className="flex flex-col gap-5">
      {payload.duplicates.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-[var(--warn)]">
          检测到重复键：{payload.duplicates.join('、')}。保存时会同时更新所有同名键。
        </div>
      )}
      {GROUPS.map((group) => (
        <section key={group.title} className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">{group.title}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {group.fields.map((key) => {
              const value = values[key] ?? '';
              return (
                <Field key={key} label={key}>
                  {BOOL_KEYS.has(key) ? (
                    <Select value={value || 'false'} onChange={(event) => set(key, event.target.value)} aria-label={key}>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </Select>
                  ) : ENUM_OPTIONS[key] ? (
                    <Select value={value} onChange={(event) => set(key, event.target.value)} aria-label={key}>
                      {ENUM_OPTIONS[key]!.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}（{option.value}）
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      type={key === 'rcon.password' ? 'password' : 'text'}
                      value={value}
                      onChange={(event) => set(key, event.target.value)}
                      aria-label={key}
                    />
                  )}
                </Field>
              );
            })}
          </div>
        </section>
      ))}
      {extras.length > 0 && (
        <p className="text-xs text-[var(--muted)]">
          其余 {extras.length} 个字段未在表单中展示，可切换到原始编辑修改。
        </p>
      )}
      {isDirty(payload, values) && (
        <p className="text-xs text-[var(--warn)]">修改将在保存后写入；多数配置需要重启服务器生效。</p>
      )}
    </div>
  );
}
