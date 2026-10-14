// Copies the gotchea-web bundle (packages/web/dist) into dist/web/ for `gotchea serve`.
// Runs after tsup (which cleans dist/). The web UI is a build-time input only: the
// published CLI ships the static files and has no runtime dependency on gotchea-web.
import { cp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const to = fileURLToPath(new URL('../dist/web/', import.meta.url));

const index = await stat(join(from, 'index.html')).catch(() => null);
if (!index?.isFile()) {
  console.error(`copy-web: ${join(from, 'index.html')} is missing. Build the web UI first: pnpm --filter gotchea-web build (or pnpm build at the root).`);
  process.exit(1);
}
await rm(to, { recursive: true, force: true });
await cp(from, to, { recursive: true });
