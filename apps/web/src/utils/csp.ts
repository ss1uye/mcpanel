export function readCspNonce(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? '';
}
