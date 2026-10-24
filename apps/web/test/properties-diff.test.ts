import { describe, expect, it } from 'vitest';
import { diffProperties, parsePropertiesText } from '../src/utils/properties';

const RAW = '# comment\nmotd=Old\nserver-port=25565\nmotd=Old2\n\nview-distance=10\n';

describe('parsePropertiesText', () => {
  it('keeps duplicates and order', () => {
    const parsed = parsePropertiesText(RAW);
    expect(parsed.entries.map((entry) => entry.key)).toEqual(['motd', 'server-port', 'motd', 'view-distance']);
    expect(parsed.duplicates).toEqual(['motd']);
  });
});

describe('diffProperties', () => {
  it('returns only changed keys using the last occurrence', () => {
    const next = RAW.replace('motd=Old2', 'motd=New').replace('view-distance=10', 'view-distance=12');
    expect(diffProperties(RAW, next)).toEqual({ motd: 'New', 'view-distance': '12' });
    expect(diffProperties(RAW, RAW)).toEqual({});
  });

  it('ignores removed keys', () => {
    expect(diffProperties(RAW, 'server-port=25565\n')).toEqual({});
  });
});
