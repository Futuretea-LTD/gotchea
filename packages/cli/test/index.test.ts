import { describe, expect, it } from 'vitest';
import { VERSION } from 'gotchea-core';
import { createProgram } from '../src/program.js';

describe('gotchea cli', () => {
  it('creates the root command with the core version', () => {
    const program = createProgram();
    expect(program.name()).toBe('gotchea');
    expect(program.version()).toBe(VERSION);
  });
});
