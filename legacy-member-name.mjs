// Repair the verified legacy display alias without changing any account identity.
export function normalizeLegacyMemberName(database,configuredLegacyId) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const target=database.prepare("SELECT id,name,username FROM trusted_users WHERE username_key='sigmit64'").get();
    const legacy=database.prepare("SELECT id FROM trusted_users WHERE name='Trusted Member'").all();
    if (!target||target.id!==configuredLegacyId||target.username!=='Sigmit64') { database.exec('ROLLBACK');return {error:'identity-mismatch'}; }
    if (!legacy.length&&target.name==='Sigmit64') { database.exec('COMMIT');return {sameIdentity:true,updated:0}; }
    if (legacy.length!==1||legacy[0].id!==target.id) { database.exec('ROLLBACK');return {error:'different-or-ambiguous-identities'}; }
    const result=database.prepare("UPDATE trusted_users SET name='Sigmit64' WHERE id=? AND name='Trusted Member' AND username_key='sigmit64'").run(target.id);
    database.exec('COMMIT');
    return {sameIdentity:true,updated:Number(result.changes)};
  } catch(error) { database.exec('ROLLBACK');throw error; }
}
