export function getWindowPostMessageTargetOrigin(origin: string): string {
  return origin === "null" ? "*" : origin;
}
