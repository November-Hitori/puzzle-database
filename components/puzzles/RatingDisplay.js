export default function RatingDisplay({ ratings = [0, 0, 0], votes = 0 }) {
  return (
    <div className="rating-set" title={`${votes} 位解题者的平均评分`}>
      <span className="rating-item">✎ <b>{Number(ratings[0] || 0).toFixed(1)}</b></span>
      <span className="rating-item">♧ <b>{Number(ratings[1] || 0).toFixed(1)}</b></span>
      <span className="rating-item">♥ <b>{Number(ratings[2] || 0).toFixed(1)}</b></span>
    </div>
  );
}
