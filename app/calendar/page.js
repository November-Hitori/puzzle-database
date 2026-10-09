import CalendarView from '../../components/calendar/CalendarView.js';
import { requireSessionUser } from '../../lib/server/session.js';
import { getCalendarLeftovers, getCalendarPuzzles, getRules } from '../../lib/data.js';

export const dynamic = 'force-dynamic';

export default async function CalendarPage() {
  const user = await requireSessionUser();
  const [puzzles, leftovers, rules] = await Promise.all([
    getCalendarPuzzles(user.id),
    getCalendarLeftovers(user.id),
    getRules(user.id)
  ]);
  return <CalendarView puzzles={puzzles} leftovers={leftovers} rules={rules} currentUser={user} />;
}
