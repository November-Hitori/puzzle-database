import Link from 'next/link';

export default function CollectionList({ collections }) {
  return (
    <div className="page-wrap-inner">
      <section className="page-heading">
        <div>
          <p className="eyebrow"><span className="eyebrow-line" />CURATED SETS</p>
          <h1>题集列表<span className="heading-period">.</span></h1>
          <p className="page-description">按主题、比赛和编辑精选浏览一组题目。</p>
        </div>
      </section>
      <section className="collection-directory collection-directory-first">
        <div className="section-heading compact">
          <div className="section-title-group"><h2>全部题集</h2><span className="count-badge">{String(collections.length).padStart(2, '0')}</span></div>
          <span className="mono muted">DATABASE COLLECTIONS</span>
        </div>
        <div className="collection-list">
          {collections.map((collection) => (
            <Link className="collection-row collection-row-large" href={`/collections/${collection.id}`} key={collection.id}>
              <span className={`collection-cover ${collection.id % 2 ? 'cover-green' : 'cover-red'}`}>{collection.id % 2 ? 'N°' : 'PB'}<span>{collection.year || 'SET'}</span></span>
              <span className="collection-info">
                <strong>{collection.name}</strong>
                <small>{Number(collection.puzzle_count || 0)} puzzles · {collection.year || '未定年份'} · {collection.source || '未注明来源'}</small>
                <em>{collection.description || ''}</em>
              </span>
              <span className="collection-arrow">↗</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
