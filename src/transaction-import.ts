import crypto from "node:crypto";
import type { SanitizedTransaction, Transaction } from "./types.js";
import { MatchingService } from "./matching.js";

type ImportStage = "received" | "redacting" | "minimizing" | "ready" | "error";

export type ImportStatus = {
  jobId: string;
  stage: ImportStage;
  message: string;
  progress: number;
  profileId?: string;
  month?: string;
  transactionCount?: number;
  error?: string;
};

type ImportJob = ImportStatus & { transactions?: Transaction[] };

/** Handles consented CSV snapshots without persisting the raw upload. */
export class TransactionImportService {
  private readonly jobs = new Map<string, ImportJob>();

  constructor(private readonly matching: MatchingService) {}

  start(csv: string): ImportStatus {
    const jobId = crypto.randomUUID();
    const job: ImportJob = {
      jobId,
      stage: "received",
      message: "Transaction snapshot received.",
      progress: 12,
    };
    this.jobs.set(jobId, job);
    void this.process(jobId, csv);
    return this.publicStatus(job);
  }

  status(jobId: string): ImportStatus | null {
    const job = this.jobs.get(jobId);
    return job ? this.publicStatus(job) : null;
  }

  transactionsFor(profileId: string): Transaction[] | null {
    for (const job of this.jobs.values()) {
      if (job.profileId === profileId && job.transactions) return job.transactions;
    }
    return null;
  }

  private publicStatus(job: ImportJob): ImportStatus {
    const { transactions: _transactions, ...status } = job;
    return status;
  }

  private async process(jobId: string, csv: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    try {
      await this.advance(job, "redacting", "Removing account identifiers and sensitive text…", 38);
      const parsed = this.parse(csv);
      const rawTransactions: Transaction[] = parsed.map((row, index) => ({
        id: `import-${jobId}-${index}`,
        date: row.date,
        description: row.description,
        amount: row.amount,
        currency: row.currency,
      }));

      await this.advance(job, "minimizing", "Keeping only broad spending signals for matching…", 72);
      const sanitized = this.matching.sanitize(rawTransactions);
      const months = sanitized.map((transaction) => transaction.month).filter((month) => /^\d{4}-\d{2}$/.test(month));
      const month = months.sort().at(-1) ?? new Date().toISOString().slice(0, 7);

      // Keep only the minimized shape in memory; the original upload is discarded.
      job.transactions = sanitized.map((transaction, index) => ({
        id: `minimized-${jobId}-${index}`,
        date: `${transaction.month}-01`,
        description: transaction.description,
        amount: transaction.amount,
        currency: transaction.currency,
      }));
      job.profileId = `import-${jobId}`;
      job.month = month;
      job.transactionCount = sanitized.length;
      job.stage = "ready";
      job.progress = 100;
      job.message = "Your private snapshot is ready for cause matching.";
    } catch (error) {
      job.stage = "error";
      job.progress = 100;
      job.error = error instanceof Error ? error.message : "The transaction file could not be processed.";
      job.message = job.error;
    }
  }

  private async advance(job: ImportJob, stage: ImportStage, message: string, progress: number) {
    job.stage = stage;
    job.message = message;
    job.progress = progress;
    await new Promise((resolve) => setTimeout(resolve, 260));
  }

  private parse(csv: string): Array<{ date: string; description: string; amount: number; currency: string }> {
    if (Buffer.byteLength(csv, "utf8") > 1_000_000) throw new Error("Please choose a file smaller than 1 MB.");
    const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error("Add a CSV with a header row and at least one transaction.");

    const headers = this.splitLine(lines[0]).map((header) => header.toLowerCase().trim());
    const find = (...names: string[]) => names.map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1;
    const dateIndex = find("date", "transaction_date", "transaction date");
    const descriptionIndex = find("description", "merchant", "merchant_name", "merchant name", "category", "note");
    const amountIndex = find("amount", "value", "transaction_amount", "transaction amount");
    const currencyIndex = find("currency", "currency_code", "currency code");

    if (dateIndex < 0 || descriptionIndex < 0 || amountIndex < 0) {
      throw new Error("CSV needs date, description or merchant, and amount columns.");
    }

    const rows = lines.slice(1).map((line) => this.splitLine(line));
    if (rows.length > 500) throw new Error("Please upload no more than 500 transactions at once.");

    const transactions = rows.map((row, index) => {
      const amount = Number((row[amountIndex] ?? "").replace(/[^0-9.-]/g, ""));
      const date = row[dateIndex] ?? "";
      const description = row[descriptionIndex]?.trim();
      if (!description || !Number.isFinite(amount) || !date) {
        throw new Error(`Transaction row ${index + 2} is missing a valid date, description, or amount.`);
      }
      return { date, description, amount: Math.abs(amount), currency: row[currencyIndex]?.trim() || "USD" };
    });

    return transactions;
  }

  private splitLine(line: string): string[] {
    const values: string[] = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === '"' && line[index + 1] === '"' && quoted) {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = !quoted;
      } else if (character === "," && !quoted) {
        values.push(value);
        value = "";
      } else {
        value += character;
      }
    }
    values.push(value);
    return values;
  }
}
