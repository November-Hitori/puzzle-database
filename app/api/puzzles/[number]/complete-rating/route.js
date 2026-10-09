import { completeAndRate, getPuzzles, DEMO_USER_ID } from '../../../../../lib/data.js';
import { sendJson, readJson } from '../../../../../lib/http.js';

export const dynamic = 'force-dynamic';

export async function POST(request, { params }) {
  const { number } = await params;
  const input = await readJson(request);
  const ratings = [input.logic, input.intuition, input.enjoyment].map(Number);
  if (ratings.some((rating) => !Number.isInteger(rating) || rating < 1 || rating > 5)) {
    return sendJson({ error: 'ratings must be integers from 1 to 5' }, 400);
  }
  await completeAndRate(Number(number), DEMO_USER_ID, ratings);
  return sendJson({ puzzles: await getPuzzles(DEMO_USER_ID) });
}
