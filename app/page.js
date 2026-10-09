import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="page-wrap-inner home-page">
      <section className="workspace-header">
        <div>
          <p className="eyebrow"><span className="eyebrow-line" />PUZZLE ARCHIVE</p>
          <h1>工作台<span className="heading-period">.</span></h1>
          <p className="page-description">从公告开始，进入题库、题集和索引。</p>
        </div>
      </section>

      <section className="home-notice-board">
        <div className="notice-strip" aria-label="公告">
          <div className="notice-symbol">✦</div>
          <div className="notice-copy">
            <span className="notice-kicker">公告 · OCT 2026</span>
            <strong>秋季谜题交换开始了</strong>
            <span>提交你的原创题目，和朋友交换一场解题。</span>
          </div>
          <Link className="text-button" href="/library">查看题库 <span>→</span></Link>
        </div>
        <div className="notice-strip notice-strip-secondary">
          <div className="notice-symbol">◎</div>
          <div className="notice-copy">
            <span className="notice-kicker">最近更新 · OCT 2026</span>
            <strong>Next.js 版工作台已经启动</strong>
            <span>页面正在按题库、题目和文件管理逐步迁移。</span>
          </div>
          <Link className="text-button" href="/library">进入题库 <span>→</span></Link>
        </div>
      </section>

      <section className="home-links">
        <Link href="/library" className="home-link-card">
          <span className="home-link-icon">▤</span>
          <span><small>EXPLORE</small><strong>题库</strong><em>浏览全部题目 →</em></span>
        </Link>
        <Link href="/collections" className="home-link-card">
          <span className="home-link-icon">▥</span>
          <span><small>CURATED</small><strong>题集列表</strong><em>按主题浏览 →</em></span>
        </Link>
        <Link href="/files" className="home-link-card">
          <span className="home-link-icon">⌘</span>
          <span><small>ORGANIZE</small><strong>索引与文件</strong><em>按来源与年份浏览 →</em></span>
        </Link>
      </section>
    </div>
  );
}
