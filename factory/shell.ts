export function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const RESULT_MARKER = "::factory-result::";

export function parseResultLine(output: string): unknown {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const start = line.indexOf(RESULT_MARKER);
    if (start !== -1) return JSON.parse(line.slice(start + RESULT_MARKER.length));
  }
  return undefined;
}
