export const DEMO_USER_ID = 'demo-user';

let modulesPromise;

async function getModules() {
  modulesPromise ||= Promise.all([
    import('./server/puzzles.js'),
    import('./server/ratings.js'),
    import('./server/folders.js'),
    import('./server/tags.js'),
    import('./server/collections.js')
  ]).then(([puzzles, ratings, folders, tags, collections]) => ({ puzzles, ratings, folders, tags, collections }));
  return modulesPromise;
}

export async function getPuzzles(userId = DEMO_USER_ID) {
  const modules = await getModules();
  return modules.puzzles.getPuzzles(userId);
}

export async function getPuzzle(number, userId = DEMO_USER_ID) {
  const modules = await getModules();
  return modules.puzzles.getPuzzle(number, userId);
}

export async function addPuzzle(input) {
  const modules = await getModules();
  return modules.puzzles.addPuzzle(input);
}

export async function completeAndRate(number, userId, ratings) {
  const modules = await getModules();
  return modules.ratings.completeAndRate(number, userId, ratings);
}

export async function addPuzzleTag(number, tag) {
  const modules = await getModules();
  return modules.tags.addPuzzleTag(number, tag);
}

export async function getTags() {
  const modules = await getModules();
  return modules.tags.getTags();
}

export async function getFolders() {
  const modules = await getModules();
  return modules.folders.getFolders();
}

export async function addFolder(name, parentId = null) {
  const modules = await getModules();
  return modules.folders.addFolder(name, parentId);
}

export async function getCollections() {
  const modules = await getModules();
  return modules.collections.getCollections();
}

export async function getCollection(id, userId = DEMO_USER_ID) {
  const modules = await getModules();
  return modules.collections.getCollection(id, userId);
}
