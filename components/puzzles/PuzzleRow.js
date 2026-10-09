import Link from 'next/link';
import RatingDisplay from './RatingDisplay.js';

export default function PuzzleRow({ puzzle }) {
  return (
    <div className={`puzzle-row ${puzzle.completed ? 'completed' : ''}`} role="row">
      <span className="cell-number" role="cell">#{puzzle.number}</span>
      <div className="puzzle-main" role="cell">
        <Link className="puzzle-title" href={`/puzzles/${puzzle.number}`}>{puzzle.title}</Link>
        <span className="puzzle-subtitle">{puzzle.type} · {puzzle.source}</span>
      </div>
      <span className="cell-author" role="cell"><span className="author-link">{puzzle.author}</span></span>
      <span className="cell-tags" role="cell">
        <div className="tag-list">
          {(puzzle.tags || []).map((tag) => <span className="tag" key={tag}>{tag}</span>)}
        </div>
      </span>
      <span className="cell-rating" role="cell"><RatingDisplay ratings={puzzle.ratings} votes={puzzle.votes} /></span>
      <Link className="row-action" title="打开详情" aria-label={`打开 ${puzzle.title}`} href={`/puzzles/${puzzle.number}`}>›</Link>
    </div>
  );
}
