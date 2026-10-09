import Link from 'next/link';
import { notFound } from 'next/navigation';
import PuzzleSolverPanel from '../../../components/puzzles/PuzzleSolverPanel.js';
import CompletionPanel from '../../../components/puzzles/CompletionPanel.js';
import TagEditor from '../../../components/puzzles/TagEditor.js';
import { getPuzzle } from '../../../lib/data.js';

export const dynamic = 'force-dynamic';

export default async function PuzzlePage({ params }) {
  const { number } = await params;
  const puzzle = await getPuzzle(Number(number));
  if (!puzzle) notFound();

  return (
    <div className="page-wrap-inner puzzle-page">
      <Link className="back-link" href="/library">← 返回题库</Link>
      <section className="puzzle-header">
        <div>
          <p className="eyebrow"><span className="eyebrow-line" />PUZZLE #{puzzle.number}</p>
          <h1>{puzzle.title}<span className="heading-period">.</span></h1>
          <p className="puzzle-meta-large">{puzzle.type}　·　由 <Link href="/authors">{puzzle.author}</Link> 发布　·　{puzzle.votes} 位解题者评分</p>
        </div>
        <div className="puzzle-header-tags">
          <div className="tag-list">{(puzzle.tags || []).map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div>
          <TagEditor puzzle={puzzle} />
        </div>
      </section>

      <section className="puzzle-content-grid">
        <div className="puzzle-board-column">
          <div className="embed-toolbar"><span className="embed-label">{puzzle.inputMode === 'blank' ? 'SELF-CONTAINED' : 'OPEN PUZZLE'}</span></div>
          <div className="puzzle-embed"><PuzzleSolverPanel puzzle={puzzle} /></div>
          <div className="puzzle-open-actions">
            <span className="muted">{puzzle.inputMode === 'blank' ? '这是一个内置填空题' : '外部题目通过上方工具按钮在新标签页打开'}</span>
          </div>
        </div>
        <aside className="puzzle-sidebar">
          <div className="detail-block"><h3>作者的话</h3><p>{puzzle.note}</p></div>
          <div className="detail-block"><h3>规则</h3><details><summary>查看题目规则</summary><p>{puzzle.rules}</p></details></div>
          <CompletionPanel puzzle={puzzle} />
          <div className="detail-block"><h3>留言板</h3><p className="muted">还没有留言。</p><div className="comment-box"><input type="text" placeholder="写下你的想法" aria-label="留言内容" /><button type="button">发送</button></div></div>
        </aside>
      </section>
    </div>
  );
}
