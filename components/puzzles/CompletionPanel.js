"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import RatingDisplay from './RatingDisplay.js';
import RatingDialog from './RatingDialog.js';

export default function CompletionPanel({ puzzle }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <div className="detail-block record-panel">
      <h3>ANSWER RECORD</h3>
      <p className="record-help">完成题目后，分别评价逻辑难度、通灵难度和喜爱程度。</p>
      <button className={`button ${puzzle.completed ? 'button-dark' : 'button-light'}`} type="button" onClick={() => setOpen(true)}>
        {puzzle.completed ? '✓ 已完成 · 修改评分' : '标记为已完成'}
      </button>
      {puzzle.userRating ? <div className="submitted-rating"><span>我的评分</span><RatingDisplay ratings={puzzle.userRating} votes={1} /></div> : null}
      {open ? <RatingDialog puzzle={puzzle} onClose={() => setOpen(false)} onSaved={() => router.refresh()} /> : null}
    </div>
  );
}
