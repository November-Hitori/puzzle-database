export const DEMO_USER_ID = 'demo-user';

let databaseModulePromise;

function getDatabase() {
  databaseModulePromise ||= import('./server/database.js');
  return databaseModulePromise;
}

export async function getPuzzle(number, userId = DEMO_USER_ID) {
  const puzzles = await getPuzzles(userId);
  return puzzles.find((puzzle) => puzzle.number === Number(number)) || null;
}

export async function getPuzzles(...args) {
  const database = await getDatabase();
  return database.getPuzzles(...args);
}

export async function addPuzzle(...args) {
  const database = await getDatabase();
  return database.addPuzzle(...args);
}

export async function getRules(...args) {
  const database = await getDatabase();
  return database.getRules(...args);
}

export async function getRule(...args) {
  const database = await getDatabase();
  return database.getRule(...args);
}

export async function ruleHasVariants(...args) {
  const database = await getDatabase();
  return database.ruleHasVariants(...args);
}

export async function getInbox(...args) {
  const database = await getDatabase();
  return database.getInbox(...args);
}

export async function markInboxNotificationRead(...args) {
  const database = await getDatabase();
  return database.markInboxNotificationRead(...args);
}

export async function markAllInboxNotificationsRead(...args) {
  const database = await getDatabase();
  return database.markAllInboxNotificationsRead(...args);
}

export async function deleteRule(...args) {
  const database = await getDatabase();
  return database.deleteRule(...args);
}

export async function addRule(...args) {
  const database = await getDatabase();
  return database.addRule(...args);
}

export async function updateRule(...args) {
  const database = await getDatabase();
  return database.updateRule(...args);
}

export async function submitRuleAudit(...args) {
  const database = await getDatabase();
  return database.submitRuleAudit(...args);
}

export async function getCalendarPuzzles(...args) {
  const database = await getDatabase();
  return database.getCalendarPuzzles(...args);
}

export async function getCalendarPuzzle(...args) {
  const database = await getDatabase();
  return database.getCalendarPuzzle(...args);
}

export async function getCalendarLeftovers(...args) {
  const database = await getDatabase();
  return database.getCalendarLeftovers(...args);
}

export async function addCalendarPuzzle(...args) {
  const database = await getDatabase();
  return database.addCalendarPuzzle(...args);
}

export async function deleteCalendarPuzzle(...args) {
  const database = await getDatabase();
  return database.deleteCalendarPuzzle(...args);
}

export async function updateCalendarSuggestedDate(...args) {
  const database = await getDatabase();
  return database.updateCalendarSuggestedDate(...args);
}

export async function calendarPuzzleExists(...args) {
  const database = await getDatabase();
  return database.calendarPuzzleExists(...args);
}

export async function completeCalendarReview(...args) {
  const database = await getDatabase();
  return database.completeCalendarReview(...args);
}

export async function reenterCalendarPuzzle(...args) {
  const database = await getDatabase();
  return database.reenterCalendarPuzzle(...args);
}

export async function completeAndRate(...args) {
  const database = await getDatabase();
  return database.completeAndRate(...args);
}

export async function getFolders(...args) {
  const database = await getDatabase();
  return database.getFolders(...args);
}

export async function addFolder(...args) {
  const database = await getDatabase();
  return database.addFolder(...args);
}

export async function addPuzzleTag(...args) {
  const database = await getDatabase();
  return database.addPuzzleTag(...args);
}

export async function getTags(...args) {
  const database = await getDatabase();
  return database.getTags(...args);
}

export async function getCollections(...args) {
  const database = await getDatabase();
  return database.getCollections(...args);
}

export async function getCollection(...args) {
  const database = await getDatabase();
  return database.getCollection(...args);
}

export async function upsertTrustedUser(...args) {
  const database = await getDatabase();
  return database.upsertTrustedUser(...args);
}

export async function retainTrustedUsers(...args) {
  const database = await getDatabase();
  return database.retainTrustedUsers(...args);
}

export async function authBootstrapComplete(...args) {
  const database = await getDatabase();
  return database.authBootstrapComplete(...args);
}

export async function bootstrapLegacyAuth(...args) {
  const database = await getDatabase();
  return database.bootstrapLegacyAuth(...args);
}

export async function findUserByUsernameKey(...args) {
  const database = await getDatabase();
  return database.findUserByUsernameKey(...args);
}

export async function registerAccountWithGate(...args) {
  const database = await getDatabase();
  return database.registerAccountWithGate(...args);
}

export async function setRegistrationGate(...args) {
  const database = await getDatabase();
  return database.setRegistrationGate(...args);
}

export async function disableRegistrationGate(...args) {
  const database = await getDatabase();
  return database.disableRegistrationGate(...args);
}

export async function revokeAccount(...args) {
  const database = await getDatabase();
  return database.revokeAccount(...args);
}

export async function createSession(...args) {
  const database = await getDatabase();
  return database.createSession(...args);
}

export async function findSession(...args) {
  const database = await getDatabase();
  return database.findSession(...args);
}

export async function deleteSession(...args) {
  const database = await getDatabase();
  return database.deleteSession(...args);
}
