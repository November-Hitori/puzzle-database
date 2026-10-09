import { addPuzzleTag, getPuzzles, getTags, DEMO_USER_ID } from '../../../../../lib/data.js';
import { sendJson, readJson } from '../../../../../lib/http.js';

export const dynamic = 'force-dynamic';

export async function POST(request, { params }) {
  const { number } = await params;
  const input = await readJson(request);
  if (!input.tag || input.tag.length > 40) {
    return sendJson({ error: 'tag is required and must be 40 characters or fewer' }, 400);
  }
  await addPuzzleTag(Number(number), input.tag.trim());
  return sendJson({ puzzles: await getPuzzles(DEMO_USER_ID), tags: await getTags() });
}
