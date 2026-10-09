import { addPuzzle, getPuzzles, DEMO_USER_ID } from '../../../lib/data.js';
import { sendJson, readJson } from '../../../lib/http.js';
import { isTrustedPuzzleUrl } from '../../../lib/puzzle-url.mjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  return sendJson({ puzzles: await getPuzzles(DEMO_USER_ID) });
}

export async function POST(request) {
  const input = await readJson(request);
  if (!input.title) return sendJson({ error: 'title is required' }, 400);
  if (input.inputMode !== 'blank' && !isTrustedPuzzleUrl(input.url)) {
    return sendJson({ error: 'only supported puzzle tool URLs are allowed' }, 400);
  }
  const id = await addPuzzle(input);
  return sendJson({ id, puzzles: await getPuzzles(DEMO_USER_ID) }, 201);
}
