export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export function percent(ratio: number): string {
  const r = Math.max(0, Math.min(1, ratio));
  return `${Math.round(r * 100)}%`;
}
