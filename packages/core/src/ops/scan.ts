// Scan entry point shared by the CLI and the MCP server.
import { scanRepo, type ScanOptions, type ScanResult } from '../scan/scan.js';

/** Counts only; chunk ids and diffs stay in `ScanResult`. */
export interface ScanSummary {
  added: number;
  changed: number;
  moved: number;
  removed: number;
  /** Chunks tracked after the scan. */
  total: number;
}

export type RunScanOptions = Omit<ScanOptions, 'root'>;

export function summarizeScan(result: ScanResult): ScanSummary {
  const { diff } = result;
  return {
    added: diff.added.length,
    changed: diff.changed.length,
    moved: diff.moved.length,
    removed: diff.removed.length,
    total: result.chunks.length,
  };
}

/** Scans the repo (persisting results unless `dryRun`) and returns the summary plus the full result. */
export async function runScan(
  repoRoot: string,
  opts: RunScanOptions = {},
): Promise<{ summary: ScanSummary; result: ScanResult }> {
  const result = await scanRepo({ ...opts, root: repoRoot });
  return { summary: summarizeScan(result), result };
}
