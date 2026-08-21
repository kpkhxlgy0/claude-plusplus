export const CLAUDE_PLUSPLUS_VERSION = "0.3.0";

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function compareVersions(left: string, right: string): number {
  const a = VERSION_RE.exec(left);
  const b = VERSION_RE.exec(right);
  if (!a || !b) return 0;
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(a[index]) - Number(b[index]);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}
