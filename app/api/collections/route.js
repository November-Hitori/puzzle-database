import { getCollections } from '../../../lib/data.js';
import { sendJson } from '../../../lib/http.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  return sendJson({ collections: await getCollections() });
}
