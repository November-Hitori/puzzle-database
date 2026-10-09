import Link from 'next/link';
import { notFound } from 'next/navigation';
import PuzzleSolverPanel from '../../../components/puzzles/PuzzleSolverPanel.js';
import CalendarReviewForm from '../../../components/calendar/CalendarReviewForm.js';
import { requireSessionUser } from '../../../lib/server/session.js';
import { getCalendarPuzzle } from '../../../lib/data.js';

export const dynamic = 'force-dynamic';

export default async function CalendarPuzzlePage({ params }) {
  const user = await requireSessionUser();
  const { number } = await params;
  const puzzle = await getCalendarPuzzle(Number(number), user.id);
  if (!puzzle) notFound();
  return (
    <div className="page-wrap-inner puzzle-page">
      <Link className="back-link" href="/calendar">← 返回谜题日历</Link>
      <section className="puzzle-header"><div><p className="eyebrow"><span className="eyebrow-line" />CALENDAR PUZZLE #{puzzle.number}</p><h1>{puzzle.title}<span className="heading-period">.</span></h1><p className="puzzle-meta-large">{puzzle.author}　·　第 {puzzle.reviewRound} 轮　·　{puzzle.calendarStatus}</p></div></section>
      <section className="puzzle-content-grid"><div className="puzzle-board-column"><div className="embed-toolbar"><span className="embed-label">OPEN PUZZLE</span></div><div className="puzzle-embed"><PuzzleSolverPanel puzzle={puzzle} /></div></div><aside className="puzzle-sidebar"><div className="detail-block"><h3>作者的话</h3><p>{puzzle.note || '暂无说明。'}</p></div><div className="detail-block"><h3>规则</h3><p>{puzzle.rules}</p></div><CalendarReviewForm puzzle={puzzle} /></aside></section>
    </div>
  );
}
