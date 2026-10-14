// Machine-readable output. The documents themselves (MapJson, StatusJson) are built in
// gotchea-core, shared with MCP and `gotchea serve`; they never contain answer data.
export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
