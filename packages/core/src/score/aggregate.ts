// Bottom-up state computation over a chunk tree. Pure.
import type { ScoreConfig } from '../config/schema.js';
import type { Chunk } from '../model/chunk.js';
import type { ChunkState, Progress } from '../model/progress.js';
import { chunkState, parentState } from './state.js';

export interface TreeStateInput {
  chunks: readonly Pick<Chunk, 'id' | 'parentId' | 'isLeaf' | 'metrics'>[];
  /** `ok` question count per leaf id; missing = 0. */
  okQuestions: ReadonlyMap<string, number>;
  progress: Readonly<Record<string, Progress>>;
  now: Date;
  cfg: ScoreConfig;
}

/** States for every chunk: leaves from progress, parents by LOC-weighted aggregation. */
export function computeTreeStates(input: TreeStateInput): Map<string, ChunkState> {
  const children = new Map<string, Pick<Chunk, 'id' | 'isLeaf' | 'metrics'>[]>();
  for (const c of input.chunks) {
    if (c.parentId === null) continue;
    const list = children.get(c.parentId);
    if (list) list.push(c);
    else children.set(c.parentId, [c]);
  }
  const states = new Map<string, ChunkState>();
  const visit = (c: Pick<Chunk, 'id' | 'isLeaf' | 'metrics'>): ChunkState => {
    const cached = states.get(c.id);
    if (cached) return cached;
    const kids = children.get(c.id) ?? [];
    const state =
      c.isLeaf || kids.length === 0
        ? chunkState(input.okQuestions.get(c.id) ?? 0, input.progress[c.id], input.now, input.cfg)
        : parentState(
            kids.map((k) => ({ loc: k.metrics.loc, R: visit(k).R })),
            input.cfg,
          );
    states.set(c.id, state);
    return state;
  };
  for (const c of input.chunks) visit(c);
  return states;
}
