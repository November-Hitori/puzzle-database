"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getPuzzleSource, isTrustedPuzzleUrl } from '../../lib/puzzle-url.mjs';
import { actions, useAppDispatch } from '../../lib/state/app-store.js';

export default function AddPuzzleDialog({ onClose }) {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const [mode, setMode] = useState('external');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    if (!title.trim()) {
      setError('请填写题目标题');
      return;
    }
    if (mode === 'external' && !isTrustedPuzzleUrl(url.trim())) {
      setError('外部题目必须使用受支持的 puzz.link、Penpa+ 或同类工具链接');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/puzzles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          type: mode === 'blank' ? '填空题' : '逻辑题',
          author: author.trim() || '未署名',
          source: mode === 'blank' ? '填空题' : getPuzzleSource(url.trim()),
          url: url.trim(),
          inputMode: mode,
          answer: ''
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const created = data.puzzles.find((puzzle) => puzzle.title === title.trim());
      dispatch(actions.setPuzzles(data.puzzles));
      dispatch(actions.pushToast('题目已创建'));
      onClose();
      router.refresh();
      if (created) router.push(`/puzzles/${created.number}`);
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
        <form onSubmit={handleSubmit}>
          <p className="modal-eyebrow">NEW ENTRY</p>
          <h2 id="modalTitle">添加一道题目</h2>
          <p className="modal-intro">支持 puzz.link、Penpa+ 外链，或选择纯填空题。</p>
          <label className="form-field">
            <span>题目链接</span>
            <input value={url} onChange={(event) => setUrl(event.target.value)} type="url" placeholder="https://puzz.link/p?..." />
          </label>
          <label className="form-field">
            <span>题目标题</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} type="text" placeholder="例如：Five Cells" />
          </label>
          <label className="form-field">
            <span>作者</span>
            <input value={author} onChange={(event) => setAuthor(event.target.value)} type="text" placeholder="作者名" />
          </label>
          <label className="form-field">
            <span>类型</span>
            <select value={mode} onChange={(event) => setMode(event.target.value)}>
              <option value="external">外部题目（puzz.link / Penpa+）</option>
              <option value="blank">纯填空题</option>
            </select>
          </label>
          {error ? <p className="blank-result error">{error}</p> : null}
          <div className="modal-footer">
            <button className="button button-light" type="button" onClick={onClose}>取消</button>
            <button className="button button-dark" type="submit" disabled={submitting}>{submitting ? '保存中…' : '保存题目'}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
