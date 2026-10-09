import Link from 'next/link';

export default function CollectionDetail({ collection }) {
  const puzzles = collection.puzzles || [];
  return (
    <div className="page-wrap-inner collection-page">
      <Link className="back-link" href="/collections">← 返回题集列表</Link>
      <section className="collection-detail-header">
        <div>
          <p className="eyebrow"><span className="eyebrow-line" />COLLECTION · {collection.year || '—'}</p>
          <h1>{collection.name}<span className="heading-period">.</span></h1>
          <p className="page-description">{collection.description || ''}</p>
          <p className="collection-detail-meta">{collection.source || '未注明来源'}　·　{puzzles.length} 道题目</p>
        </div>
        <span className="collection-detail-mark">{collection.year ? String(collection.year).slice(-2) : 'SET'}</span>
      </section>
      <section className="collection-detail-grid">
        <div>
          <div className="section-heading compact">
            <div className="section-title-group"><h2>题目</h2><span className="count-badge">{String(puzzles.length).padStart(2, '0')}</span></div>
            <span className="mono muted">ORDERED BY COLLECTION</span>
          </div>
          <div className="collection-puzzle-list">
            {puzzles.map((puzzle) => (
              <Link className="collection-puzzle-row" href={`/puzzles/${puzzle.number}`} key={puzzle.number}>
                <span className="collection-puzzle-number">#{puzzle.number}</span>
                <span><strong>{puzzle.title}</strong><small>{puzzle.author} · {puzzle.source}</small></span>
                <span className="collection-puzzle-status">{puzzle.completed ? '已完成' : '未完成'}</span>
              </Link>
            ))}
          </div>
        </div>
        <aside className="collection-materials">
          <span className="materials-kicker">MATERIALS</span>
          <h2>题集资料</h2>
          {[['IB', collection.ib], ['PB', collection.pb], ['SB', collection.sb]].map(([label, value]) => (
            <div className="material-row" key={label}><span>{label}</span><strong>{value || '暂无资料'}</strong><button type="button">↗</button></div>
          ))}
        </aside>
      </section>
    </div>
  );
}
