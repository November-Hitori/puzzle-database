"use client";

import { useState } from 'react';

export default function BlankPuzzle({ puzzle }) {
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState({ message: '', type: '' });

  function checkAnswer() {
    const normalized = answer.trim().toLowerCase();
    const expected = String(puzzle.answer || '').toLowerCase();
    if (!normalized) {
      setResult({ message: '请填写答案。', type: 'error' });
    } else if (expected && normalized === expected) {
      setResult({ message: '答案正确，可以提交完成记录。', type: 'success' });
    } else {
      setResult({ message: expected ? '还不正确，再试一次。' : '答案已记录，点击完成后进行评分。', type: '' });
    }
  }

  return (
    <div className="blank-puzzle">
      <span className="blank-kicker">FILL IN</span>
      <h2>{puzzle.title}</h2>
      <p>请根据规则填写答案。</p>
      <label>
        <span>你的答案</span>
        <input value={answer} onChange={(event) => setAnswer(event.target.value)} type="text" placeholder="输入答案" />
      </label>
      <button className="button button-dark" type="button" onClick={checkAnswer}>检查答案</button>
      <p className={`blank-result ${result.type}`}>{result.message}</p>
    </div>
  );
}
