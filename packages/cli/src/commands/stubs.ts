// Commands planned for later milestones (PLAN.md §9).
import type { CommandContext } from '../context.js';

export interface StubCommand {
  name: string;
  args?: string;
  description: string;
  milestone: string;
}

export const STUB_COMMANDS: readonly StubCommand[] = [];

export function stubCommand(ctx: CommandContext, stub: StubCommand): void {
  ctx.out(`gotchea ${stub.name}: not implemented yet (${stub.milestone})`);
}
