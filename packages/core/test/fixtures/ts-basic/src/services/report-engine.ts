// ReportEngine is deliberately oversized (> splitAboveLoc normalized LOC) so the
// chunker splits it into its methods plus a `~body` remainder (fields).
import { average, clamp, roundTo, sum } from '../util/math.js';
import { padLeft, padRight, truncate } from '../util/strings.js';

export interface ReportRow {
  id: string;
  owner: string;
  amount: number;
  category: string;
  at: number;
}

export interface ReportOptions {
  currency: string;
  locale: string;
  pageSize?: number;
}

export interface Summary {
  count: number;
  total: number;
  mean: number;
  min: number;
  max: number;
}

export class ReportEngine {
  private rows: ReportRow[] = [];
  private readonly currency: string;
  private readonly locale: string;
  private readonly pageSize: number;
  private frozen = false;
  private revision = 0;
  private readonly listeners: Array<(revision: number) => void> = [];

  constructor(options: ReportOptions) {
    this.currency = options.currency;
    this.locale = options.locale;
    this.pageSize = clamp(options.pageSize ?? 25, 1, 500);
  }

  get size(): number {
    return this.rows.length;
  }

  get isFrozen(): boolean {
    return this.frozen;
  }

  get currentRevision(): number {
    return this.revision;
  }

  freeze(): void {
    this.frozen = true;
  }

  onChange(listener: (revision: number) => void): void {
    this.listeners.push(listener);
  }

  addRow(row: ReportRow): void {
    if (this.frozen) {
      throw new Error('report is frozen');
    }
    if (!Number.isFinite(row.amount)) {
      throw new Error(`invalid amount for ${row.id}`);
    }
    if (row.id.length === 0) {
      throw new Error('row id must not be empty');
    }
    const existing = this.rows.findIndex((r) => r.id === row.id);
    if (existing >= 0) {
      this.rows[existing] = { ...row };
    } else {
      this.rows.push({ ...row });
    }
    this.bump();
  }

  removeRow(id: string): boolean {
    if (this.frozen) {
      throw new Error('report is frozen');
    }
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    const removed = this.rows.length !== before;
    if (removed) {
      this.bump();
    }
    return removed;
  }

  summarize(rows: readonly ReportRow[] = this.rows): Summary {
    if (rows.length === 0) {
      return { count: 0, total: 0, mean: 0, min: 0, max: 0 };
    }
    const amounts = rows.map((r) => r.amount);
    let min = amounts[0]!;
    let max = amounts[0]!;
    for (const a of amounts) {
      if (a < min) min = a;
      if (a > max) max = a;
    }
    return {
      count: rows.length,
      total: roundTo(sum(amounts), 2),
      mean: roundTo(average(amounts), 2),
      min,
      max,
    };
  }

  byCategory(): Map<string, Summary> {
    const groups = new Map<string, ReportRow[]>();
    for (const row of this.rows) {
      const key = row.category.trim().toLowerCase() || 'uncategorized';
      const list = groups.get(key);
      if (list) {
        list.push(row);
      } else {
        groups.set(key, [row]);
      }
    }
    const out = new Map<string, Summary>();
    const keys = [...groups.keys()].sort();
    for (const key of keys) {
      out.set(key, this.summarize(groups.get(key)!));
    }
    return out;
  }

  byOwner(): Map<string, Summary> {
    const groups = new Map<string, ReportRow[]>();
    for (const row of this.rows) {
      const list = groups.get(row.owner);
      if (list) {
        list.push(row);
      } else {
        groups.set(row.owner, [row]);
      }
    }
    const out = new Map<string, Summary>();
    for (const [owner, rows] of groups) {
      out.set(owner, this.summarize(rows));
    }
    return out;
  }

  between(from: number, to: number): ReportRow[] {
    if (from > to) {
      throw new Error('from must not be after to');
    }
    const out: ReportRow[] = [];
    for (const row of this.rows) {
      if (row.at < from) {
        continue;
      }
      if (row.at > to) {
        continue;
      }
      out.push(row);
    }
    out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    return out;
  }

  page(index: number): ReportRow[] {
    const pages = Math.max(1, Math.ceil(this.rows.length / this.pageSize));
    const safe = clamp(index, 0, pages - 1);
    const start = safe * this.pageSize;
    const sorted = [...this.rows].sort((a, b) => a.at - b.at);
    const slice = sorted.slice(start, start + this.pageSize);
    if (slice.length === 0 && this.rows.length > 0) {
      throw new Error('page computation failed');
    }
    return slice;
  }

  topN(n: number): ReportRow[] {
    const limit = clamp(n, 0, this.rows.length);
    const sorted = [...this.rows].sort((a, b) => {
      if (b.amount !== a.amount) {
        return b.amount - a.amount;
      }
      if (a.at !== b.at) {
        return a.at - b.at;
      }
      return a.id.localeCompare(b.id);
    });
    const out = sorted.slice(0, limit);
    if (out.length < limit) {
      throw new Error('not enough rows');
    }
    return out;
  }

  outliers(threshold = 2): ReportRow[] {
    if (this.rows.length < 3) {
      return [];
    }
    const amounts = this.rows.map((r) => r.amount);
    const mean = average(amounts);
    const variance = average(amounts.map((a) => (a - mean) ** 2));
    const deviation = Math.sqrt(variance);
    if (deviation === 0) {
      return [];
    }
    const out: ReportRow[] = [];
    for (const row of this.rows) {
      const z = Math.abs(row.amount - mean) / deviation;
      if (z > threshold) {
        out.push(row);
      }
    }
    return out;
  }

  formatAmount(amount: number): string {
    const rounded = roundTo(amount, 2);
    const negative = rounded < 0;
    const abs = Math.abs(rounded);
    const whole = Math.floor(abs);
    const cents = Math.round((abs - whole) * 100);
    const groupSep = this.locale === 'de' ? '.' : ',';
    const decimalSep = this.locale === 'de' ? ',' : '.';
    const digits = String(whole);
    let grouped = '';
    for (let i = 0; i < digits.length; i++) {
      const fromEnd = digits.length - i;
      grouped += digits[i];
      if (fromEnd > 1 && fromEnd % 3 === 1) {
        grouped += groupSep;
      }
    }
    const text = `${grouped}${decimalSep}${padLeft(String(cents), 2, '0')} ${this.currency}`;
    return negative ? `-${text}` : text;
  }

  renderTable(rows: readonly ReportRow[] = this.rows): string {
    const header = [padRight('id', 12), padRight('owner', 16), padRight('category', 14), padLeft('amount', 16)];
    const lines = [header.join(' | ')];
    lines.push('-'.repeat(lines[0]!.length));
    for (const row of rows) {
      const cells = [
        padRight(truncate(row.id, 12), 12),
        padRight(truncate(row.owner, 16), 16),
        padRight(truncate(row.category, 14), 14),
        padLeft(this.formatAmount(row.amount), 16),
      ];
      lines.push(cells.join(' | '));
    }
    const summary = this.summarize(rows);
    lines.push('-'.repeat(lines[0]!.length));
    lines.push(`count ${summary.count}, total ${this.formatAmount(summary.total)}`);
    return lines.join('\n');
  }

  toCsv(): string {
    const escape = (value: string): string => {
      if (/[",\n]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    };
    const lines = ['id,owner,category,amount,at'];
    for (const row of this.rows) {
      const cells = [escape(row.id), escape(row.owner), escape(row.category), String(row.amount), String(row.at)];
      lines.push(cells.join(','));
    }
    return `${lines.join('\n')}\n`;
  }

  fromCsv(text: string): number {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      return 0;
    }
    const [header, ...body] = lines;
    if (header !== 'id,owner,category,amount,at') {
      throw new Error('unexpected csv header');
    }
    let imported = 0;
    for (const line of body) {
      const [id, owner, category, amount, at] = line.split(',');
      if (!id || !owner || amount === undefined || at === undefined) {
        continue;
      }
      this.addRow({ id, owner, category: category ?? '', amount: Number(amount), at: Number(at) });
      imported++;
    }
    return imported;
  }

  merge(other: ReportEngine): number {
    if (other === this) {
      return 0;
    }
    if (other.currency !== this.currency) {
      throw new Error(`currency mismatch: ${other.currency} vs ${this.currency}`);
    }
    let merged = 0;
    for (const row of other.rows) {
      const existing = this.rows.find((r) => r.id === row.id);
      if (existing && existing.at >= row.at) {
        continue;
      }
      this.addRow(row);
      merged++;
    }
    return merged;
  }

  snapshot(): { revision: number; rows: ReportRow[]; frozen: boolean } {
    const rows = this.rows.map((r) => ({ ...r }));
    rows.sort((a, b) => a.id.localeCompare(b.id));
    return {
      revision: this.revision,
      rows,
      frozen: this.frozen,
    };
  }

  restore(state: { revision: number; rows: ReportRow[]; frozen: boolean }): void {
    if (state.revision < this.revision) {
      throw new Error('cannot restore an older revision');
    }
    this.rows = state.rows.map((r) => ({ ...r }));
    this.frozen = state.frozen;
    this.revision = state.revision;
    for (const listener of this.listeners) {
      listener(this.revision);
    }
  }

  runningTotals(): Array<{ id: string; total: number }> {
    const sorted = [...this.rows].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const out: Array<{ id: string; total: number }> = [];
    let total = 0;
    for (const row of sorted) {
      total = roundTo(total + row.amount, 2);
      out.push({ id: row.id, total });
    }
    if (out.length !== this.rows.length) {
      throw new Error('running totals lost rows');
    }
    return out;
  }

  private bump(): void {
    this.revision += 1;
    for (const listener of this.listeners) {
      try {
        listener(this.revision);
      } catch {
        // listeners must not break the engine
      }
    }
  }
}
