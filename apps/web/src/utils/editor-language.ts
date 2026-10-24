export type EditorLanguage = 'json' | 'yaml' | 'properties';

export function detectEditorLanguage(path: string): EditorLanguage | null {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  if (extension === 'json') return 'json';
  if (extension === 'yml' || extension === 'yaml') return 'yaml';
  if (extension === 'properties') return 'properties';
  return null;
}
