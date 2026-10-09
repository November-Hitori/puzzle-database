import { addFolder, getFolders } from '../../../lib/data.js';
import { sendJson, readJson } from '../../../lib/http.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  return sendJson({ folders: await getFolders() });
}

export async function POST(request) {
  const input = await readJson(request);
  if (!input.name) return sendJson({ error: 'name is required' }, 400);
  const id = await addFolder(input.name, input.parentId);
  return sendJson({ id, folders: await getFolders() }, 201);
}
