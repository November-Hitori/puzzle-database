// Remove obsolete neutral votes and their evaluations once; retain completion records.
export function removeNeutralCalendarReviews(database) {
  if (database.prepare('SELECT 1 FROM calendar_review_schema_migrations WHERE version=2').get()) return false;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`DELETE FROM puzzle_ratings WHERE EXISTS (
      SELECT 1 FROM calendar_review_votes v JOIN puzzles p ON p.id=v.puzzle_id
      WHERE p.scope='calendar' AND v.vote='neutral'
        AND v.puzzle_id=puzzle_ratings.puzzle_id AND v.user_id=puzzle_ratings.user_id);
      DELETE FROM calendar_evaluations WHERE EXISTS (
        SELECT 1 FROM calendar_review_votes v WHERE v.vote='neutral'
          AND v.puzzle_id=calendar_evaluations.puzzle_id AND v.user_id=calendar_evaluations.user_id
          AND v.review_round=calendar_evaluations.review_round);
      DELETE FROM calendar_review_votes WHERE vote='neutral';
      DELETE FROM calendar_review_vote_events WHERE vote='neutral';`);
    database.prepare('INSERT INTO calendar_review_schema_migrations(version) VALUES (2)').run();
    database.exec('COMMIT');
    return true;
  } catch(error) { database.exec('ROLLBACK'); throw error; }
}
