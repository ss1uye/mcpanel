import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectJava, javaCandidates, parseJavaMajor } from '../../src/nodes/java-detect';

describe('java detection', () => {
  it('parses old and new version strings', () => {
    expect(parseJavaMajor('openjdk version "21.0.4" 2024-07-16')).toBe(21);
    expect(parseJavaMajor('java version "1.8.0_402"')).toBe(8);
    expect(parseJavaMajor('not a java version')).toBeNull();
  });

  it('builds unique candidates with javaPath first', () => {
    const candidates = javaCandidates('/custom/java', { JAVA_HOME: '/jdk' });
    expect(candidates[0]).toBe('/custom/java');
    expect(candidates).toContain(path.join('/jdk', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it('falls through candidates until one works', async () => {
    const result = await detectJava(null, async (command) => {
      if (command === 'java') return 'openjdk version "21.0.4"';
      throw new Error('not found');
    });
    expect(result).toEqual({ path: 'java', major: 21 });
  });
});
