/** Host-owned, read-back verified local journal for the standalone example.
 * A production multi-host gateway must implement the same interface using a
 * transactional store. Files use exclusive per-key locks and atomic rename.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FeedbackSignal } from "./detector.js";

export type FeedbackStatus = "pending" | "dismissed" | "filed";
export type FeedbackDisposition = {
  key: string;
  messageId: string;
  sessionId: string;
  sourceHash: string;
  signal: FeedbackSignal;
  status: FeedbackStatus;
  reason: string;
  category?: string;
  caseRef?: string;
  recordedAt: string;
};

export interface DispositionJournal {
  read(key: string): Promise<FeedbackDisposition | undefined>;
  /** Never regress a final disposition to pending; return the existing final. */
  save(record: FeedbackDisposition): Promise<FeedbackDisposition>;
}

export const sourceHash = (text: string) => createHash("sha256").update(text).digest("hex");
export const dispositionKey = (sessionId: string, messageId: string) =>
  JSON.stringify([sessionId, messageId]);

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

export class FileDispositionJournal implements DispositionJournal {
  constructor(private readonly directory: string) {}

  private path(key: string): string {
    return join(this.directory, `${sourceHash(key)}.json`);
  }

  async read(key: string): Promise<FeedbackDisposition | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path(key), "utf8");
    } catch (error) {
      if (codeOf(error) === "ENOENT") return undefined;
      throw error;
    }
    // Corrupt/partial records fail closed; never treat corruption as absence.
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("key" in parsed) ||
      parsed.key !== key ||
      !("status" in parsed) ||
      !["pending", "dismissed", "filed"].includes(String(parsed.status))
    ) {
      throw new Error("Invalid feedback disposition journal entry");
    }
    return parsed as FeedbackDisposition;
  }

  async save(record: FeedbackDisposition): Promise<FeedbackDisposition> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(record.key);
    const lock = `${target}.lock`;
    // EEXIST locks fail closed. An abandoned lock requires operator resolution.
    await mkdir(lock, { mode: 0o700 });
    let tmp: string | undefined;
    try {
      const previous = await this.read(record.key);
      if (previous && previous.sourceHash !== record.sourceHash) {
        throw new Error("Message id reused with different text");
      }
      if (previous && previous.status !== "pending") return previous;
      if (previous && record.status === "pending") return previous;
      tmp = `${target}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(record, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await rename(tmp, target);
      tmp = undefined;
      const readback = await this.read(record.key);
      if (!readback) throw new Error("Disposition disappeared after write");
      return readback;
    } finally {
      if (tmp) await rm(tmp, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}
