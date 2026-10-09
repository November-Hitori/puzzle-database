"use client";

import { useState } from 'react';
import RatingDisplay from './RatingDisplay.js';
import { actions, useAppDispatch } from '../../lib/state/app-store.js';

const dimensions = [
  ['logic', '✎ 逻辑难度'],
  ['intuition', '♧ 通灵难度'],
  ['love', '♥ 喜爱程度']
];

export default function RatingDialog({ puzzle, onClose, onSaved }) {
  const dispatch = useAppDispatch();
  const initial = puzzle.userRating || [3, 3, 3];
  const [ratings, setRatings] = useState(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch(`/api/puzzles/${puzzle.number}/complete-rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logic: ratings[0], intuition: ratings[1], enjoyment: ratings[2] })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      dispatch(actions.setPuzzles(data.puzzles));
      dispatch(actions.pushToast('完成记录已保存'));
      onClose();
      onSaved();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <button className="modal-close icon-button" type="button" aria-label="关闭" onClick={onClose}>×</button>
        <p className="modal-eyebrow">ANSWER RECORD · #{puzzle.number}</p>
        <h2 id="modalTitle">完成并评分</h2>
        <p className="modal-intro">请在完成 {puzzle.title} 后，为三个维度各给出 1–5 分。</p>
        <div className="rating-form">
          {dimensions.map(([key, label], index) => (
            <label key={key}>
              <span>{label} <b>{ratings[index]}</b></span>
              <input
                type="range"
                min="1"
                max="5"
                step="1"
                value={ratings[index]}
                onChange={(event) => {
                  const next = [...ratings];
                  next[index] = Number(event.target.value);
                  setRatings(next);
                }}
              />
            </label>
          ))}
        </div>
        {error ? <p className="blank-result error">{error}</p> : null}
        <div className="modal-footer">
          <button className="button button-light" type="button" onClick={onClose}>取消</button>
          <button className="button button-dark" type="button" onClick={submit} disabled={submitting}>{submitting ? '保存中…' : '提交完成记录'}</button>
        </div>
      </section>
    </div>
  );
}
