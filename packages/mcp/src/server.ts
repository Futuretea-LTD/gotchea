// Transport-agnostic server factory: connect it to stdio, or to an in-memory transport in tests.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from 'gotchea-core';
import { createToolContext, type ServerOptions } from './context.js';
import { registerGetGenerationTasks } from './tools/get_generation_tasks.js';
import { registerGetChunkForFile } from './tools/get_chunk_for_file.js';
import { registerGetMap } from './tools/get_map.js';
import { registerGetStatus } from './tools/get_status.js';
import { registerSaveQuestions } from './tools/save_questions.js';
import { registerScan } from './tools/scan.js';
import { registerStartQuiz } from './tools/start_quiz.js';
import { registerSubmitAnswer } from './tools/submit_answer.js';

export type { ServerOptions } from './context.js';

export function createServer(opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'gotchea', version: VERSION });
  const ctx = createToolContext(opts);
  registerScan(server, ctx);
  registerGetMap(server, ctx);
  registerGetChunkForFile(server, ctx);
  registerGetStatus(server, ctx);
  registerGetGenerationTasks(server, ctx);
  registerSaveQuestions(server, ctx);
  registerStartQuiz(server, ctx);
  registerSubmitAnswer(server, ctx);
  // Recover persisted sessions from ~/.gotchea/repos/<id>/sessions/ without delaying the handshake.
  void ctx.warm();
  return server;
}
