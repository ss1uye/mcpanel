import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { StreamLanguage } from '@codemirror/language';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { EditorState, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';
import { readCspNonce } from '../utils/csp';
import { detectEditorLanguage } from '../utils/editor-language';

const theme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'var(--console-bg)', color: 'var(--console-fg)', fontSize: '12px' },
    '.cm-scroller': { fontFamily: 'ui-monospace, Consolas, "Courier New", monospace', overflow: 'auto' },
    '.cm-gutters': { backgroundColor: 'var(--console-bg)', color: 'var(--muted)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--surface-2) 55%, transparent)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent' },
    '&.cm-focused': { outline: 'none' },
  },
  { dark: true },
);

function languageExtension(path: string): Extension {
  const language = detectEditorLanguage(path);
  if (language === 'json') return json();
  if (language === 'yaml') return yaml();
  if (language === 'properties') return StreamLanguage.define(properties);
  return [];
}

export default function CodeEditor({
  path,
  value,
  onChange,
  ariaLabel,
  heightClass = 'h-80',
}: {
  path: string;
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  heightClass?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return undefined;
    const nonce = readCspNonce();
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          oneDark,
          theme,
          EditorView.lineWrapping,
          languageExtension(path),
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changeRef.current(update.state.doc.toString());
          }),
          ...(nonce ? [EditorView.cspNonce.of(nonce)] : []),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // 只在切换文件时重建编辑器；value 的后续变化由下一个 effect 同步。
  }, [path]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} className={`${heightClass} overflow-hidden rounded-lg border border-[var(--border)]`} />;
}
