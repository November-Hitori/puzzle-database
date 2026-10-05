import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addFolder, addPuzzle, addPuzzleTag, completeAndRate, getCollection, getCollections, getFolders, getPuzzles, getTags } from './db.mjs';
import { parseTrustedPuzzleUrl, TRUSTED_PUZZLE_FRAME_SOURCES } from './puzzle-url.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const userId = 'demo-user';
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  `frame-src ${TRUSTED_PUZZLE_FRAME_SOURCES.join(' ')}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join('; ');

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  if (!body) return {};
  return JSON.parse(body);
}

function isSupportedPuzzleUrl(value) {
  return parseTrustedPuzzleUrl(value) !== null;
}

async function handleApi(request, response, pathname) {
  if (request.method === 'GET' && pathname === '/api/puzzles') return sendJson(response, 200, { puzzles: getPuzzles(userId) });
  if (request.method === 'GET' && pathname === '/api/folders') return sendJson(response, 200, { folders: getFolders() });
  if (request.method === 'GET' && pathname === '/api/collections') return sendJson(response, 200, { collections: getCollections() });
  if (request.method === 'GET' && pathname === '/api/tags') return sendJson(response, 200, { tags: getTags() });
  const collectionMatch = pathname.match(/^\/api\/collections\/(\d+)$/);
  if (request.method === 'GET' && collectionMatch) {
    const collection = getCollection(Number(collectionMatch[1]), userId);
    return collection ? sendJson(response, 200, { collection }) : sendJson(response, 404, { error: 'collection not found' });
  }
  if (request.method === 'POST' && pathname === '/api/puzzles') {
    const input = await readJson(request);
    if (!input.title) return sendJson(response, 400, { error: 'title is required' });
    if (input.inputMode !== 'blank' && !isSupportedPuzzleUrl(input.url)) return sendJson(response, 400, { error: 'only supported puzzle tool URLs are allowed' });
    const id = addPuzzle(input);
    return sendJson(response, 201, { id, puzzles: getPuzzles(userId) });
  }
  const ratingMatch = pathname.match(/^\/api\/puzzles\/(\d+)\/complete-rating$/);
  if (request.method === 'POST' && ratingMatch) {
    const input = await readJson(request);
    const ratings = [input.logic, input.intuition, input.enjoyment].map(Number);
    if (ratings.some((rating) => !Number.isInteger(rating) || rating < 1 || rating > 5)) return sendJson(response, 400, { error: 'ratings must be integers from 1 to 5' });
    completeAndRate(Number(ratingMatch[1]), userId, ratings);
    return sendJson(response, 200, { puzzles: getPuzzles(userId) });
  }
  if (request.method === 'POST' && pathname === '/api/folders') {
    const input = await readJson(request);
    if (!input.name) return sendJson(response, 400, { error: 'name is required' });
    const id = addFolder(input.name, input.parentId);
    return sendJson(response, 201, { id, folders: getFolders() });
  }
  const tagMatch = pathname.match(/^\/api\/puzzles\/(\d+)\/tags$/);
  if (request.method === 'POST' && tagMatch) {
    const input = await readJson(request);
    if (!input.tag || input.tag.length > 40) return sendJson(response, 400, { error: 'tag is required and must be 40 characters or fewer' });
    addPuzzleTag(Number(tagMatch[1]), input.tag.trim());
    return sendJson(response, 200, { puzzles: getPuzzles(userId), tags: getTags() });
  }
  sendJson(response, 404, { error: 'API route not found' });
}

function serveStatic(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(rootDir, relative);
  if (!filePath.startsWith(rootDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return sendJson(response, 404, { error: 'Not found' });
  response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream', 'Content-Security-Policy': contentSecurityPolicy, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN' });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url.pathname);
    return serveStatic(response, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: 'Internal server error' });
  }
});

server.listen(port, () => console.log(`PuzArchive server running at http://localhost:${port}`));
