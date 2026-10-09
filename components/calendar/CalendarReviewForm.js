"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CALENDAR_REVIEW_TAGS, CALENDAR_REVIEW_VOTES } from '../../lib/policy/calendar-review-policy.mjs';

export default function CalendarReviewForm({ puzzle }) {
  const router = useRouter();
  const [difficulty, setDifficulty] = useState(puzzle.evaluation?.difficulty || 3);
  const [tags, setTags] = useState(puzzle.evaluation?.tags || []);
  const [vote, setVote] = useState(puzzle.userVote || 'support');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch(`/api/calendar/puzzles/${puzzle.number}/complete-rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ difficulty, tags, vote, expectedReviewRound: puzzle.reviewRound })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      router.refresh();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="detail-block record-panel calendar-review-form">
      <h3>完成与评价</h3>
      <p className="record-help">难度 1–6，可选择评价标签，并为本轮投票。</p>
      <label className="form-field"><span>难度：{difficulty} / 6</span><input type="range" min="1" max="6" value={difficulty} onChange={(event) => setDifficulty(Number(event.target.value))} /></label>
      <div className="calendar-tag-options">{CALENDAR_REVIEW_TAGS.map((tag) => <label key={tag}><input type="checkbox" checked={tags.includes(tag)} onChange={(event) => setTags((current) => event.target.checked ? [...current, tag] : current.filter((item) => item !== tag))} />{tag}</label>)}</div>
      <div className="calendar-vote-options">{CALENDAR_REVIEW_VOTES.map((value) => <label key={value}><input type="radio" name="vote" checked={vote === value} onChange={() => setVote(value)} />{value}</label>)}</div>
      {error ? <p className="blank-result error">{error}</p> : null}
      <button className="button button-dark" type="button" onClick={submit} disabled={submitting}>{submitting ? '提交中…' : '提交评价与投票'}</button>
    </div>
  );
}
