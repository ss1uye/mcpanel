// eslint-disable-next-line no-control-regex -- the ANSI CSI introducer is a literal ESC byte by design
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}
