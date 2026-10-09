import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {normalizeLegacyMemberName} from '../legacy-member-name.mjs';

test('legacy display repair verifies identity and preserves credentials, sessions and business records',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE trusted_users(id TEXT PRIMARY KEY,name TEXT,username TEXT,username_key TEXT UNIQUE,password_hash TEXT,is_active INTEGER);
      CREATE TABLE member_sessions(token_hash TEXT,user_id TEXT,expires_at INTEGER);
      CREATE TABLE completions(puzzle_id INTEGER,user_id TEXT);
      INSERT INTO trusted_users VALUES('fixture-target','Trusted Member','Sigmit64','sigmit64','fake-private-hash',1),('fixture-other','Other','Other','other','other-fake-hash',1);
      INSERT INTO member_sessions VALUES('fake-session','fixture-target',99999999999);
      INSERT INTO completions VALUES(42,'fixture-target');`);
    const privateBefore=db.prepare('SELECT id,username,username_key,password_hash,is_active FROM trusted_users ORDER BY id').all();
    const sessionBefore=db.prepare('SELECT * FROM member_sessions').all();
    const completionBefore=db.prepare('SELECT * FROM completions').all();
    assert.deepEqual(normalizeLegacyMemberName(db,'wrong-id'),{error:'identity-mismatch'});
    assert.equal(db.prepare("SELECT name FROM trusted_users WHERE id='fixture-target'").get().name,'Trusted Member');
    assert.deepEqual(normalizeLegacyMemberName(db,'fixture-target'),{sameIdentity:true,updated:1});
    assert.deepEqual(normalizeLegacyMemberName(db,'fixture-target'),{sameIdentity:true,updated:0});
    assert.deepEqual(db.prepare('SELECT id,username,username_key,password_hash,is_active FROM trusted_users ORDER BY id').all(),privateBefore);
    assert.deepEqual(db.prepare('SELECT * FROM member_sessions').all(),sessionBefore);
    assert.deepEqual(db.prepare('SELECT * FROM completions').all(),completionBefore);
    db.exec("UPDATE trusted_users SET name='Trusted Member' WHERE id='fixture-other'");
    assert.deepEqual(normalizeLegacyMemberName(db,'fixture-target'),{error:'different-or-ambiguous-identities'});
    assert.equal(db.prepare("SELECT name FROM trusted_users WHERE id='fixture-other'").get().name,'Trusted Member');
  } finally {db.close();}
});
