import {getCalendarReviewStatus} from './calendar-review-policy.mjs';

export function migrateCalendarScores(database,onApproval=()=>{}) {
  if (database.prepare('SELECT 1 FROM calendar_review_schema_migrations WHERE version=4').get()) return false;
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['calendar_review_votes','calendar_review_vote_events']) {
      const columns=database.prepare(`PRAGMA table_info(${table})`).all();
      if (!columns.some(c=>c.name==='score')) database.exec(`ALTER TABLE ${table} ADD COLUMN score INTEGER CHECK(score IN (-2,-1,0,1,2))`);
      database.exec(`UPDATE ${table} SET score=CASE vote WHEN 'support' THEN 2 WHEN 'oppose' THEN -2 WHEN 'neutral' THEN 0 ELSE NULL END`);
    }
    const totals=database.prepare(`SELECT COUNT(score) AS scoredCount,COALESCE(SUM(score),0) AS totalScore,
      COALESCE(SUM(CASE WHEN vote='veto' THEN 1 ELSE 0 END),0) AS veto FROM calendar_review_votes WHERE puzzle_id=? AND review_round=?`);
    for (const puzzle of database.prepare("SELECT id,number,title,submitted_by,calendar_status,review_round FROM puzzles WHERE scope='calendar'").all()) {
      // A previously vetoed round remains archived until explicit reentry.
      const status=puzzle.calendar_status==='leftover'?'leftover':getCalendarReviewStatus(totals.get(puzzle.id,puzzle.review_round));
      if (status===puzzle.calendar_status) continue;
      database.prepare(`UPDATE puzzles SET calendar_status=?,assigned_date=CASE WHEN ?<>'approved' THEN NULL ELSE assigned_date END,
        edit_version=edit_version+1 WHERE id=?`).run(status,status,puzzle.id);
      if (status==='approved') onApproval(puzzle);
    }
    database.prepare('INSERT INTO calendar_review_schema_migrations(version) VALUES(4)').run();
    database.exec('COMMIT');return true;
  } catch(error) {database.exec('ROLLBACK');throw error;}
}
