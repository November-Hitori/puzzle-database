import Link from 'next/link';

const avatarClasses = ['coral', 'mint', 'navy', 'amber'];

export default function AuthorsView({ puzzles }) {
  const authors = Array.from(new Set(puzzles.map((puzzle) => puzzle.author)));
  return (
    <div className="page-wrap-inner">
      <section className="page-heading"><div><p className="eyebrow"><span className="eyebrow-line" />CREATORS</p><h1>作者<span className="heading-period">.</span></h1><p className="page-description">按照作者浏览他们命制的所有题目。</p></div></section>
      <div className="author-grid">
        {authors.map((author, index) => {
          const authored = puzzles.filter((puzzle) => puzzle.author === author);
          return <Link href="/library" className="author-card" key={author}><span className={`author-card-avatar avatar-${avatarClasses[index % avatarClasses.length]}`}>{author[0]}</span><strong>{author}</strong><small>{authored.length} 道题目</small><span>查看题目 →</span></Link>;
        })}
      </div>
    </div>
  );
}
