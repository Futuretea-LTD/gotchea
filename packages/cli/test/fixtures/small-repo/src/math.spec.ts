import { clamp } from './math';

if (clamp(5, 0, 1) !== 1) throw new Error('clamp');
