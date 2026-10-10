import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {hashPassword} from '../password-hash.mjs';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'puzarchive-inbox-'));
process.env.PUZARCHIVE_DB_PATH=path.join(directory,'fixture.sqlite');
process.env.PUZARCHIVE_USERS_PATH=path.join(directory,'members.json');
fs.writeFileSync(process.env.PUZARCHIVE_USERS_PATH,JSON.stringify([{id:'inbox-owner',name:'Inbox Owner',accessCode:'isolated-inbox-invitation-001'}]));
const {createServer}=await import('../server.mjs');
const {database,createSession}=await import('../db.mjs');
const iconTags=['star','flag','bookmark','heart'];

test('inbox icon tags and read filters are persistent, recipient scoped and paginated together',async(t)=>{
  const server=createServer();
  t.after(async()=>{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    database.close();
    fs.rmSync(directory,{recursive:true,force:true});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${server.address().port}`;
  const cookies={};
  const passwordHash=await hashPassword('isolated-inbox-test-password');
  for (const [id,username] of [['inbox-owner','InboxOwner'],['inbox-other','InboxOther'],['inbox-empty','InboxEmpty']]) {
    database.prepare(`INSERT INTO trusted_users(id,name,username,username_key,password_hash,is_active)
      VALUES (?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET username=excluded.username,username_key=excluded.username_key,password_hash=excluded.password_hash,is_active=1`)
      .run(id,username,username,username.toLowerCase(),passwordHash);
    const token=`isolated-session-${id}`;
    createSession(createHash('sha256').update(token).digest('hex'),id,Date.now()+60000);
    cookies[id]=`puzarchive_session=${token}`;
  }
  async function request(route,{method='GET',body,rawBody,member='inbox-owner',origin=base}={}) {
    const payload=rawBody===undefined&&body!==undefined?JSON.stringify(body):rawBody;
    const response=await fetch(base+route,{method,headers:{origin,'content-type':'application/json',...(member?{cookie:cookies[member]}:{})},...(payload!==undefined?{body:payload}:{})});
    return {status:response.status,body:await response.json()};
  }
  let sequence=0;
  function addNotification(member='inbox-owner',readAt=null) {
    sequence+=1;
    return Number(database.prepare(`INSERT INTO user_notifications
      (recipient_user_id,kind,title,body,entity_type,entity_id,dedupe_key,created_at,read_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(member,'calendar-approved',`Notification ${sequence}`,`Body ${sequence}`,'calendar-puzzle',800+sequence,`inbox-test-${sequence}`,'2026-01-01 12:00:00',readAt).lastInsertRowid);
  }
  function resetNotifications() { database.exec('DELETE FROM user_notifications'); }
  const row=(id)=>database.prepare('SELECT * FROM user_notifications WHERE id=?').get(id);
  async function setTags(id,tags,options={}) {
    return request(`/api/inbox/${id}/tags`,{method:'PATCH',body:{tags},...options});
  }

  await t.test('multiple icon tags replace the set without changing message data or read state',async()=>{
    resetNotifications();
    const unreadId=addNotification(),readId=addNotification('inbox-owner','2026-02-03 04:05:06');
    const originalUnread=row(unreadId),originalRead=row(readId);
    const initial=await request('/api/inbox');
    assert.equal(initial.status,200);
    assert.deepEqual(initial.body.notifications.map(item=>item.tags),[[],[]]);
    assert.equal(initial.body.unreadCount,1);
    const changed=await setTags(unreadId,['heart','star','bookmark','flag','star','heart']);
    assert.equal(changed.status,200);
    assert.deepEqual(changed.body,{id:unreadId,tags:iconTags});
    assert.equal((await setTags(readId,['heart','flag'])).status,200);
    const tagged=(await request('/api/inbox')).body;
    assert.deepEqual(tagged.notifications.find(item=>item.id===unreadId).tags,iconTags);
    assert.deepEqual(tagged.notifications.find(item=>item.id===readId).tags,['flag','heart']);
    assert.equal(tagged.unreadCount,1);
    assert.deepEqual(row(unreadId),originalUnread);
    assert.deepEqual(row(readId),originalRead);
    assert.equal((await setTags(unreadId,['bookmark'])).status,200);
    assert.deepEqual((await request('/api/inbox')).body.notifications.find(item=>item.id===unreadId).tags,['bookmark']);
    assert.equal((await setTags(readId,[])).status,200);
    assert.deepEqual((await request('/api/inbox')).body.notifications.find(item=>item.id===readId).tags,[]);
    assert.deepEqual(row(readId),originalRead);
  });

  await t.test('authentication, same origin and ownership protect tag updates',async()=>{
    resetNotifications();
    const ownId=addNotification(),otherId=addNotification('inbox-other');
    assert.equal((await setTags(otherId,['heart'],{member:'inbox-other'})).status,200);
    const otherBefore=row(otherId);
    assert.equal((await request('/api/inbox',{member:null})).status,401);
    assert.equal((await setTags(ownId,['star'],{member:null})).status,401);
    assert.equal((await setTags(ownId,['star'],{origin:'https://other.example'})).status,403);
    assert.equal((await setTags(otherId,['star'])).status,404);
    assert.equal((await setTags(ownId,['star'],{member:'inbox-other'})).status,404);
    for (const id of [0,9007199254740992,999999999]) assert.equal((await setTags(id,['star'])).status,404);
    assert.deepEqual(row(otherId),otherBefore);
    const ownerInbox=(await request('/api/inbox')).body;
    assert.deepEqual(ownerInbox.notifications.map(item=>item.id),[ownId]);
    assert.deepEqual(ownerInbox.notifications[0].tags,[]);
    const otherInbox=(await request('/api/inbox',{member:'inbox-other'})).body;
    assert.deepEqual(otherInbox.notifications.map(item=>item.id),[otherId]);
    assert.deepEqual(otherInbox.notifications[0].tags,['heart']);
    assert.deepEqual((await request('/api/inbox?read=unread&tag=tagged',{member:'inbox-empty'})).body,{notifications:[],unreadCount:0,nextBefore:null});
  });

  await t.test('invalid tag bodies cannot change existing tags or mark a notification read',async()=>{
    resetNotifications();
    const id=addNotification('inbox-owner','2026-02-03 04:05:06');
    assert.equal((await setTags(id,['star','heart'])).status,200);
    const before=row(id);
    const invalidBodies=[
      {},null,[],{tags:null},{tags:'star'},{tags:{}},{tags:1},{tags:true},
      {tags:['unknown']},{tags:['Star']},{tags:['★']},{tags:['']},{tags:['star',null]},
      {tags:[1]},{tags:[true]},{tags:[{}]},{tags:[['star']]},
      {tags:['star'],recipientUserId:'inbox-other'},
      {tags:['star'],readAt:null},{tags:['star'],id}
    ];
    for (const body of invalidBodies) {
      const result=await request(`/api/inbox/${id}/tags`,{method:'PATCH',body});
      assert.equal(result.status,400,JSON.stringify(body));
      assert.deepEqual(row(id),before);
      assert.deepEqual((await request('/api/inbox')).body.notifications[0].tags,['star','heart']);
    }
    for (const rawBody of [undefined,'{bad-json']) {
      assert.equal((await request(`/api/inbox/${id}/tags`,{method:'PATCH',rawBody})).status,400);
    }
    assert.equal((await request('/api/inbox')).body.unreadCount,0);
  });

  await t.test('all nine filter combinations apply before pagination and keep the global unread count',async()=>{
    resetNotifications();
    const patterns=[
      {read:true,tags:[]},{read:false,tags:['star']},{read:true,tags:['flag','heart']},
      {read:false,tags:[]},{read:false,tags:['bookmark','heart']},{read:true,tags:['heart']}
    ];
    const fixtures=[];
    for (let index=0;index<18;index+=1) {
      const pattern=patterns[index%patterns.length];
      const id=addNotification('inbox-owner',pattern.read?'2026-02-03 04:05:06':null);
      if (pattern.tags.length) assert.equal((await setTags(id,pattern.tags)).status,200);
      fixtures.unshift({id,...pattern});
      addNotification('inbox-other');
    }
    const unreadCount=fixtures.filter(item=>!item.read).length;
    for (const read of ['all','read','unread']) for (const tag of ['all','tagged','untagged']) {
      const expected=fixtures.filter(item=>(read==='all'||item.read===(read==='read'))&&(tag==='all'||Boolean(item.tags.length)===(tag==='tagged')));
      const seen=[];
      let before=null;
      do {
        const result=await request(`/api/inbox?limit=2&read=${read}&tag=${tag}${before===null?'':`&before=${before}`}`);
        assert.equal(result.status,200);
        const page=result.body;
        const offset=seen.length;
        const expectedPage=expected.slice(offset,offset+2);
        assert.deepEqual(page.notifications.map(item=>item.id),expectedPage.map(item=>item.id),`read=${read}, tag=${tag}, before=${before}`);
        assert.equal(page.unreadCount,unreadCount);
        assert.equal(page.nextBefore,offset+2<expected.length?expectedPage.at(-1).id:null);
        for (const item of page.notifications) {
          const fixture=expected.find(entry=>entry.id===item.id);
          assert.deepEqual(item.tags,fixture.tags);
          assert.equal(Boolean(item.readAt),fixture.read);
        }
        seen.push(...page.notifications.map(item=>item.id));
        before=page.nextBefore;
      } while (before!==null);
      assert.deepEqual(seen,expected.map(item=>item.id));
      const exhausted=(await request(`/api/inbox?read=${read}&tag=${tag}&before=${fixtures.at(-1).id}`)).body;
      assert.deepEqual(exhausted,{notifications:[],unreadCount,nextBefore:null});
    }
    const all=(await request('/api/inbox?limit=50')).body;
    assert.deepEqual(all.notifications.map(item=>item.id),fixtures.map(item=>item.id));
    assert.equal(all.nextBefore,null);
    assert.equal(all.unreadCount,unreadCount);
    const direct=(await request(`/api/inbox?limit=2&read=unread&tag=tagged&before=${fixtures[4].id}`)).body;
    assert.deepEqual(direct.notifications.map(item=>item.id),fixtures.filter(item=>item.id<fixtures[4].id&&!item.read&&item.tags.length).slice(0,2).map(item=>item.id));
    assert.equal(direct.unreadCount,unreadCount);
    const taggedUnread=fixtures.find(item=>!item.read&&item.tags.length);
    assert.equal((await request(`/api/inbox/${taggedUnread.id}/read`,{method:'POST',body:{}})).status,200);
    const afterRead=(await request('/api/inbox?read=read&tag=tagged')).body;
    assert.deepEqual(afterRead.notifications.find(item=>item.id===taggedUnread.id).tags,taggedUnread.tags);
    assert.equal(afterRead.unreadCount,unreadCount-1);
    const readAll=await request('/api/inbox/read-all',{method:'POST',body:{}});
    assert.equal(readAll.status,200);
    assert.equal(readAll.body.unreadCount,0);
    assert.deepEqual((await request('/api/inbox?read=unread&tag=tagged')).body,{notifications:[],unreadCount:0,nextBefore:null});
    assert.deepEqual((await request('/api/inbox?limit=50')).body.notifications.map(item=>item.tags),fixtures.map(item=>item.tags));
  });

  await t.test('invalid filters and cursors are rejected',async()=>{
    for (const query of [
      'read=invalid','read=','read=true','tag=invalid','tag=','tag=star',
      'limit=0','limit=51','limit=1.5','limit=NaN',
      'before=0','before=-1','before=1.5','before=9007199254740992','before=NaN'
    ]) assert.equal((await request(`/api/inbox?${query}`)).status,400,query);
  });
});

test('legacy inbox migration adds tag storage and preserves notification rows and read timestamps across restarts',()=>{
  const migrationDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'puzarchive-inbox-migration-'));
  const dbPath=path.join(migrationDirectory,'legacy.sqlite');
  try {
    const old=new DatabaseSync(dbPath);
    old.exec(`CREATE TABLE user_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      dedupe_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      read_at TEXT
    );
    INSERT INTO user_notifications VALUES
      (7,'legacy-owner','calendar-approved','Unread legacy','Original unread body','calendar-puzzle',800,'legacy-notification-7','2025-01-02 03:04:05',NULL),
      (18,'legacy-owner','rule-rejected','Read legacy','Original read body','rule',42,'legacy-notification-18','2025-02-03 04:05:06','2025-03-04 05:06:07'),
      (35,'legacy-other','calendar-approved','Other member','Other member body',NULL,NULL,'legacy-notification-35','2025-04-05 06:07:08',NULL);`);
    const legacyRows=old.prepare('SELECT * FROM user_notifications ORDER BY id').all().map(row=>({...row}));
    const legacyColumns=old.prepare('PRAGMA table_info(user_notifications)').all().map(column=>({...column}));
    old.close();
    const moduleUrl=new URL('../db.mjs',import.meta.url).href;
    function restart(writeTags=false) {
      const source=`import {database,getInbox,setInboxNotificationTags} from ${JSON.stringify(moduleUrl)};
        const result={initial:getInbox('legacy-owner'),
          tagCountBefore:database.prepare('SELECT COUNT(*) AS count FROM user_notification_tags').get().count};
        ${writeTags?"result.updated=setInboxNotificationTags('legacy-owner',18,['heart','star','heart']);":''}
        result.rows=database.prepare('SELECT * FROM user_notifications ORDER BY id').all();
        result.columns=database.prepare('PRAGMA table_info(user_notifications)').all();
        result.inbox=getInbox('legacy-owner');
        result.tagCountAfter=database.prepare('SELECT COUNT(*) AS count FROM user_notification_tags').get().count;
        console.log(JSON.stringify(result));database.close();`;
      const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',env:{...process.env,PUZARCHIVE_DB_PATH:dbPath,PUZARCHIVE_USERS_PATH:path.join(migrationDirectory,'members.json')}});
      assert.equal(child.error,undefined,child.error?.message);
      assert.equal(child.status,0,`${child.stderr}\n${child.stdout}`);
      return JSON.parse(child.stdout.trim().split('\n').at(-1));
    }
    const first=restart(true);
    assert.deepEqual(first.rows,legacyRows);
    assert.deepEqual(first.columns,legacyColumns);
    assert.equal(first.tagCountBefore,0);
    assert.deepEqual(first.initial.notifications.map(item=>item.tags),[[],[]]);
    assert.deepEqual(first.updated,{id:18,tags:['star','heart']});
    assert.equal(first.tagCountAfter,2);
    assert.equal(first.inbox.unreadCount,1);
    assert.deepEqual(first.inbox.notifications.map(item=>item.id),[18,7]);
    assert.equal(first.inbox.notifications[0].readAt,'2025-03-04 05:06:07');
    const second=restart();
    assert.deepEqual(second.rows,legacyRows);
    assert.deepEqual(second.columns,legacyColumns);
    assert.deepEqual(second.initial,first.inbox);
    assert.deepEqual(second.inbox,first.inbox);
    assert.equal(second.tagCountBefore,2);
    assert.equal(second.tagCountAfter,2);
  } finally { fs.rmSync(migrationDirectory,{recursive:true,force:true}); }
});
