import { describe, expect, it } from 'vitest';
import { parseProperties, propertyValue } from '../../src/services/properties-service';

describe('properties', () => {
  it('preserves comments, order, duplicates and CRLF', () => {
    const parsed = parseProperties('# comment\r\nmotd=Hello\r\nserver-port=25565\r\nmotd=World\r\n\r\n');
    expect(parsed.eol).toBe('\r\n');
    expect(parsed.entries.map((entry) => entry.key)).toEqual(['motd', 'server-port', 'motd']);
    expect(parsed.duplicates).toEqual(['motd']);
    expect(propertyValue(parsed, 'motd')).toBe('World');
    expect(propertyValue(parsed, 'missing', 'fallback')).toBe('fallback');
  });

  it('ignores blank lines and comments', () => {
    expect(parseProperties('! comment\n\nlevel-name=world\n').entries).toEqual([{ key: 'level-name', value: 'world', line: 3 }]);
  });
});
