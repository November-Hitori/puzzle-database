import { getCollection, DEMO_USER_ID } from '../../../../lib/data.js';
import { sendJson } from '../../../../lib/http.js';

export const dynamic = 'force-dynamic';

export async function GET(_request, { params }) {
  const { id } = await params;
  const collection = await getCollection(Number(id), DEMO_USER_ID);
  return collection ? sendJson({ collection }) : sendJson({ error: 'collection not found' }, 404);
}
