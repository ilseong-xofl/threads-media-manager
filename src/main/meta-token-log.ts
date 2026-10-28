import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  ManagedThreadsTokenCheck,
  ManagedThreadsTokenOperation,
} from '../shared/managed-threads';

/** One JSON line per Meta token request. There is deliberately no token field. */
export interface MetaTokenLogEntry extends ManagedThreadsTokenCheck {
  ownerId: string;
  localId: string;
  accountId: string | null;
  appName: string;
  label: string;
}

const OPERATIONS: ManagedThreadsTokenOperation[] = ['register', 'replace', 'recheck', 'refresh'];
const RESULTS: ManagedThreadsTokenCheck['result'][] = [
  'success',
  'duplicate',
  'mismatch',
  'invalid_token',
  'rejected',
  'network',
  'not_sent',
  'timeout',
  'bad_response',
];
const DETAILS = ['expired', 'short_lived', 'permission'];
const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.length >= 1 && value.length <= max;
const nullableText = (value: unknown, max: number) => value === null || text(value, max);
const nullableInteger = (value: unknown) => value === null || Number.isSafeInteger(value);
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Copies known fields only, so an extra property can never reach the plaintext file. */
function entryFields(entry: MetaTokenLogEntry): MetaTokenLogEntry {
  return {
    at: entry.at,
    ownerId: entry.ownerId,
    operation: entry.operation,
    localId: entry.localId,
    accountId: entry.accountId,
    appName: entry.appName,
    label: entry.label,
    result: entry.result,
    expiresAt: entry.expiresAt,
    detail: entry.detail,
    httpStatus: entry.httpStatus,
    metaCode: entry.metaCode,
    metaSubcode: entry.metaSubcode,
    metaType: entry.metaType,
    metaMessage: entry.metaMessage,
    fbtraceId: entry.fbtraceId,
    networkCode: entry.networkCode,
  };
}

function parseLine(line: string): MetaTokenLogEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null; // A torn last line after a crash only hides that entry.
  }
  const v = value as Record<string, unknown> | null;
  if (
    !v ||
    typeof v !== 'object' ||
    !date(v.at) ||
    !text(v.ownerId, 200) ||
    !text(v.localId, 200) ||
    !OPERATIONS.includes(v.operation as ManagedThreadsTokenOperation) ||
    !RESULTS.includes(v.result as ManagedThreadsTokenCheck['result']) ||
    !(v.expiresAt === null || date(v.expiresAt)) ||
    !(v.detail === null || DETAILS.includes(String(v.detail))) ||
    ![v.httpStatus, v.metaCode, v.metaSubcode].every(nullableInteger) ||
    !nullableText(v.accountId, 200) ||
    !nullableText(v.metaType, 80) ||
    !nullableText(v.metaMessage, 300) ||
    !nullableText(v.fbtraceId, 128) ||
    !nullableText(v.networkCode, 40) ||
    typeof v.appName !== 'string' ||
    typeof v.label !== 'string'
  )
    return null;
  return entryFields(v as unknown as MetaTokenLogEntry);
}

/**
 * Plaintext JSON-lines record of PC token checks, kept for troubleshooting with the user. It keeps
 * roughly the newest 1 MB by dropping the oldest whole lines.
 */
export class MetaTokenLog {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly filePath: string,
    private readonly maxBytes = 1024 * 1024,
  ) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }
  append(entry: MetaTokenLogEntry): Promise<void> {
    const line = `${JSON.stringify(entryFields(entry))}\n`;
    return this.serial(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      let size = 0;
      try {
        size = (await stat(this.filePath)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (size + Buffer.byteLength(line) <= this.maxBytes) {
        await appendFile(this.filePath, line, { mode: 0o600 });
        return;
      }
      const lines = size
        ? (await readFile(this.filePath, 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map((value) => `${value}\n`)
        : [];
      lines.push(line);
      let total = lines.reduce((sum, value) => sum + Buffer.byteLength(value), 0);
      while (lines.length > 1 && total > this.maxBytes) total -= Buffer.byteLength(lines.shift()!);
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, lines.join(''), { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.filePath);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
  }
  /** The newest entry per local account row of one employee. */
  latest(ownerId: string): Promise<Map<string, ManagedThreadsTokenCheck>> {
    return this.serial(async () => {
      const checks = new Map<string, ManagedThreadsTokenCheck>();
      let content: string;
      try {
        content = await readFile(this.filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return checks;
        throw error;
      }
      for (const line of content.split('\n')) {
        const entry = line ? parseLine(line) : null;
        if (!entry || entry.ownerId !== ownerId) continue;
        checks.set(entry.localId, {
          at: entry.at,
          operation: entry.operation,
          result: entry.result,
          expiresAt: entry.expiresAt,
          detail: entry.detail,
          httpStatus: entry.httpStatus,
          metaCode: entry.metaCode,
          metaSubcode: entry.metaSubcode,
          metaType: entry.metaType,
          metaMessage: entry.metaMessage,
          fbtraceId: entry.fbtraceId,
          networkCode: entry.networkCode,
        });
      }
      return checks;
    });
  }
}
