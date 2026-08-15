import type { ClaudeSessionsApi } from "@claude-plusplus/sdk";
import type { RendererTweakIpcBridge } from "../tweak-ipc.js";

export interface ClaudeSessionsApiLease {
  api: ClaudeSessionsApi;
  dispose(): void;
}

const resolveSessionFileChannel =
  "$eipc_message$_72d64a8a-c235-400b-bff0-e88c0c5a8408_$_claude.web_$_LocalSessions_$_resolveSessionFile";
const getSessionChannel =
  "$eipc_message$_72d64a8a-c235-400b-bff0-e88c0c5a8408_$_claude.web_$_LocalSessions_$_getSession";
const getTranscriptChannel =
  "$eipc_message$_72d64a8a-c235-400b-bff0-e88c0c5a8408_$_claude.web_$_LocalSessions_$_getTranscript";

export function createClaudeSessionsApiLease(bridge: RendererTweakIpcBridge): ClaudeSessionsApiLease {
  let disposed = false;
  const assertActive = (): void => {
    if (disposed) throw new Error("Claude Sessions API lease is disposed");
  };
  return {
    api: {
      async resolveFile(sessionId, filePath): Promise<string | null> {
        assertActive();
        const result = await bridge.invoke(resolveSessionFileChannel, sessionId, filePath);
        if (result !== null && typeof result !== "string") {
          throw new Error("Claude resolveSessionFile returned an invalid result");
        }
        return result;
      },
      async resolveReference(sessionId, entryId, label, occurrence, visibleCount): Promise<string | null> {
        assertActive();
        const transcript = await bridge.invoke(getTranscriptChannel, sessionId);
        return resolveTranscriptReference(transcript, entryId, label, occurrence, visibleCount);
      },
      async getWorkspaceRoot(sessionId): Promise<string | null> {
        assertActive();
        const result = await bridge.invoke(getSessionChannel, sessionId);
        if (result === null) return null;
        if (!isRecord(result)) {
          throw new Error("Claude getSession returned an invalid result");
        }
        const root = nonEmptyString(result.worktreePath) ?? nonEmptyString(result.cwd);
        if (root === null) return null;
        if (!isAbsolutePath(root)) {
          throw new Error("Claude getSession returned an invalid workspace root");
        }
        return root;
      },
    },
    dispose(): void {
      disposed = true;
    },
  };
}

function resolveTranscriptReference(
  transcript: unknown,
  entryId: string,
  label: string,
  occurrence: number,
  visibleCount: number,
): string | null {
  if (!Array.isArray(transcript) || entryId === "" || label === "" ||
    !Number.isInteger(occurrence) || occurrence < 0 || !Number.isInteger(visibleCount) ||
    visibleCount <= 0 || occurrence >= visibleCount) return null;
  const requestedLabel = normalizeReferenceLabel(label);
  if (requestedLabel === "") return null;
  const start = transcript.findIndex((row) => isAssistantEntry(row, entryId));
  if (start < 0) return null;
  const destinations: string[] = [];

  for (let index = start; index < transcript.length; index += 1) {
    const row = transcript[index];
    if (index > start && isUserTurnBoundary(row)) break;
    if (!isRecord(row) || !isRecord(row.message)) continue;
    const message = row.message;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const content of message.content) {
      if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") continue;
      destinations.push(...matchingFileDestinations(content.text, requestedLabel));
    }
  }

  if (destinations.length !== visibleCount) return null;
  return destinations[occurrence] ?? null;
}

function matchingFileDestinations(
  markdown: string,
  requestedLabel: string,
): string[] {
  const destinations: string[] = [];
  const visibleMarkdown = maskMarkdownCode(markdown);
  const links = /\[([^\]\r\n]+)\]\((file:[^)\s]+)\)/gi;
  for (const match of visibleMarkdown.matchAll(links)) {
    const start = match.index;
    if (start === undefined || isMarkdownEscaped(visibleMarkdown, start) ||
      isMarkdownImage(visibleMarkdown, start)) continue;
    const linkLabel = normalizeReferenceLabel(match[1]);
    const destination = match[2];
    if (linkLabel !== requestedLabel || !isLocalFileDestination(destination, requestedLabel)) continue;
    destinations.push(destination);
  }
  return destinations;
}

function maskMarkdownCode(markdown: string): string {
  const segments = markdown.split(/(\r\n|\r|\n)/);
  let fence: { character: string; length: number; quoteDepth: number } | null = null;
  const withoutFences = segments.map((segment) => {
    if (/^(\r\n|\r|\n)$/.test(segment)) return segment;
    const context = markdownLineContext(segment);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(context.content);
    if (fence !== null) {
      if (fence.quoteDepth === 0 || context.quoteDepth >= fence.quoteDepth) {
        if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length &&
          marker[2].trim() === "") fence = null;
        return " ".repeat(segment.length);
      }
      fence = null;
    }
    if (/^( {4}|\t)/.test(context.content)) return " ".repeat(segment.length);
    if (!marker) return segment;
    fence = {
      character: marker[1][0],
      length: marker[1].length,
      quoteDepth: context.quoteDepth,
    };
    return " ".repeat(segment.length);
  }).join("");

  const masked = withoutFences.split("");
  for (let index = 0; index < withoutFences.length;) {
    if (withoutFences[index] !== "`" || isMarkdownEscaped(withoutFences, index)) {
      index += 1;
      continue;
    }
    let length = 1;
    while (withoutFences[index + length] === "`") length += 1;
    const closing = findExactBacktickRun(withoutFences, index + length, length);
    if (closing < 0) {
      index += length;
      continue;
    }
    for (let position = index; position < closing + length; position += 1) {
      if (masked[position] !== "\r" && masked[position] !== "\n") masked[position] = " ";
    }
    index = closing + length;
  }
  return masked.join("");
}

function markdownLineContext(line: string): { content: string; quoteDepth: number } {
  let position = 0;
  let quoteDepth = 0;
  while (position < line.length) {
    let probe = position;
    let spaces = 0;
    while (spaces < 3 && line[probe] === " ") {
      probe += 1;
      spaces += 1;
    }
    if (line[probe] !== ">") break;
    quoteDepth += 1;
    position = probe + 1;
    if (line[position] === " " || line[position] === "\t") position += 1;
  }
  return { content: line.slice(position), quoteDepth };
}

function findExactBacktickRun(markdown: string, start: number, length: number): number {
  const marker = "`".repeat(length);
  let candidate = markdown.indexOf(marker, start);
  while (candidate >= 0) {
    if (markdown[candidate - 1] !== "`" && markdown[candidate + length] !== "`") return candidate;
    candidate = markdown.indexOf(marker, candidate + length);
  }
  return -1;
}

function isMarkdownEscaped(markdown: string, index: number): boolean {
  let backslashes = 0;
  for (let position = index - 1; position >= 0 && markdown[position] === "\\"; position -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isMarkdownImage(markdown: string, index: number): boolean {
  return index > 0 && markdown[index - 1] === "!" && !isMarkdownEscaped(markdown, index - 1);
}

function isAssistantEntry(value: unknown, entryId: string): boolean {
  return isRecord(value) && isRecord(value.message) &&
    value.message.role === "assistant" && value.message.id === entryId;
}

function isUserTurnBoundary(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.message) || value.message.role !== "user") return false;
  const content = value.message.content;
  return !Array.isArray(content) || content.length === 0 ||
    !content.every((item) => isRecord(item) && item.type === "tool_result");
}

function normalizeReferenceLabel(value: string): string {
  return value.trim().replace(/:(\d+)(?::\d+)?$/, "").toLowerCase();
}

function isLocalFileDestination(destination: string, requestedLabel: string): boolean {
  try {
    const url = new URL(destination);
    if (url.protocol !== "file:" || (url.hostname !== "" && url.hostname !== "localhost")) return false;
    const pathname = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:[\\/])/, "$1").replace(/\/$/, "");
    if (!/^[A-Za-z]:[\\/]/.test(pathname)) return false;
    const fileName = pathname.split(/[\\/]/).pop();
    return typeof fileName === "string" && fileName.toLowerCase() === requestedLabel;
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value) || value.startsWith("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
