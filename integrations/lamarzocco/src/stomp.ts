// STOMP 1.2 framing, as much of it as the dashboard socket uses: a command line, headers,
// a blank line, a body, and a NUL.

export type StompCommand =
  | "CONNECT"
  | "CONNECTED"
  | "SUBSCRIBE"
  | "UNSUBSCRIBE"
  | "MESSAGE"
  | "ERROR"
  | "DISCONNECT"
  | "RECEIPT";

export interface StompFrame {
  command: string;
  headers: Record<string, string>;
  body: string;
}

export function encodeFrame(
  command: StompCommand,
  headers: Record<string, string>,
  body = "",
): string {
  const lines = [command, ...Object.entries(headers).map(([k, v]) => `${k}:${v}`)];
  return `${lines.join("\n")}\n\n${body}\0`;
}

/** Undefined for a heart-beat (a bare newline) or anything that is not a frame. */
export function decodeFrame(raw: string): StompFrame | undefined {
  const text = raw.replace(/^(\r?\n)+/, "");
  const end = /\r?\n\r?\n/.exec(text);
  if (!end) return undefined;
  const [command = "", ...lines] = text.slice(0, end.index).replace(/\r/g, "").split("\n");
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    // The first occurrence of a repeated header wins (STOMP 1.2, 'Repeated Header Entries').
    if (colon > 0) headers[line.slice(0, colon)] ??= line.slice(colon + 1);
  }
  let body = text.slice(end.index + end[0].length);
  const nul = body.indexOf("\0");
  if (nul >= 0) body = body.slice(0, nul);
  return { command, headers, body };
}
