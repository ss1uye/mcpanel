import { describe, expect, it } from 'vitest';
import { detectEditorLanguage } from '../src/utils/editor-language';

describe('detectEditorLanguage', () => {
  it('maps known extensions case-insensitively', () => {
    expect(detectEditorLanguage('server.properties')).toBe('properties');
    expect(detectEditorLanguage('/config/app.yml')).toBe('yaml');
    expect(detectEditorLanguage('settings.YAML')).toBe('yaml');
    expect(detectEditorLanguage('mod.json')).toBe('json');
  });

  it('falls back to plain text', () => {
    expect(detectEditorLanguage('start.bat')).toBeNull();
    expect(detectEditorLanguage('README')).toBeNull();
  });
});
