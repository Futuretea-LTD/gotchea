import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Reporter } from 'vitest/reporters';

export interface ScenarioResult {
  scenario: string;
  status: string;
  durationMs?: number;
  errors?: readonly string[];
  notes?: readonly string[];
}

const cell = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/[\r\n]+/g, ' ');

export function renderReport(results: readonly ScenarioResult[], target: string, status: string): string {
  const lines = [
    '# Gotchea E2E report', '',
    `Target: ${cell(target)} · Result: ${cell(status)}`, '',
    '| Scenario | Status | Duration (ms) | Error summary | Measurements / notes |',
    '| --- | --- | ---: | --- | --- |',
  ];
  for (const result of results) {
    lines.push(`| ${cell(result.scenario)} | ${cell(result.status)} | ${result.durationMs?.toFixed(1) ?? '—'} | ${cell((result.errors ?? []).join('; '))} | ${cell((result.notes ?? []).join('; '))} |`);
  }
  if (results.length === 0) lines.push('| No scenarios collected | pending | — | |');
  return lines.join('\n') + '\n';
}

export class MarkdownReporter implements Reporter {
  constructor(private readonly output = fileURLToPath(new URL('../report.md', import.meta.url))) {}

  async onTestRunEnd(...[modules, unhandledErrors, reason]: Parameters<NonNullable<Reporter['onTestRunEnd']>>): Promise<void> {
    const results: ScenarioResult[] = [];
    for (const module of modules) {
      for (const test of module.children.allTests()) {
        const result = test.result();
        const duration = test.diagnostic()?.duration;
        results.push({
          scenario: `${module.relativeModuleId} > ${test.fullName}`,
          status: result.state,
          ...(duration === undefined ? {} : { durationMs: duration }),
          errors: result.errors?.map((error) => error.message ?? String(error)) ?? [],
          notes: test.annotations().map((annotation) => `${annotation.type}: ${annotation.message}`),
        });
      }
      for (const error of module.errors()) {
        results.push({ scenario: module.relativeModuleId, status: 'failed', errors: [error.message ?? String(error)] });
      }
    }
    for (const error of unhandledErrors) {
      results.push({ scenario: 'Unhandled error', status: 'failed', errors: [error.message ?? String(error)] });
    }
    await writeFile(this.output, renderReport(results, process.env['GOTCHEA_TARGET'] ?? 'local', reason));
  }
}
