import Link from 'next/link';

export default function RecordsView({ puzzles }) {
  const completed = puzzles.filter((puzzle) => puzzle.completed);
  return (
    <div className="page-wrap-inner">
      <section className="page-heading"><div><p className="eyebrow"><span className="eyebrow-line" />PERSONAL LOG</p><h1>我的记录<span className="heading-period">.</span></h1><p className="page-description">这里保存你完成过的题目和评分。</p></div></section>
      <section className="record-summary"><div><span>已完成</span><strong>{completed.length}</strong></div><div><span>已评分</span><strong>{completed.filter((puzzle) => puzzle.userRating).length}</strong></div><div><span>全部题目</span><strong>{puzzles.length}</strong></div></section>
      <section className="record-list">
        <div className="file-section-heading"><span>COMPLETED PUZZLES</span><span>{completed.length} 条记录</span></div>
        {completed.length ? completed.map((puzzle) => <Link className="record-row" href={`/puzzles/${puzzle.number}`} key={puzzle.number}><span className="record-check">✓</span><span><strong>{puzzle.title}</strong><small>#{puzzle.number} · {puzzle.author}</small></span><span className="muted">查看题目 →</span></Link>) : <div className="empty-state">还没有完成的题目。去题库挑一道开始吧。</div>}
      </section>
    </div>
  );
}
