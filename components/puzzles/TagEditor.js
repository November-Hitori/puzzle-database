"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { actions, useAppDispatch } from '../../lib/state/app-store.js';

export default function TagEditor({ puzzle }) {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState('');
  const [error, setError] = useState('');

  async function save() {
    if (!tag.trim() || tag.length > 40) {
      setError('标签不能为空且不得超过 40 个字符');
      return;
    }
    const response = await fetch(`/api/puzzles/${puzzle.number}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: tag.trim() })
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || `HTTP ${response.status}`);
      return;
    }
    dispatch(actions.setPuzzles(data.puzzles));
    dispatch(actions.setTags(data.tags || []));
    dispatch(actions.pushToast('标签已保存'));
    setOpen(false);
    setTag('');
    setError('');
    router.refresh();
  }

  return (
    <>
      <button className="tag-add-button" type="button" onClick={() => setOpen(true)}>+ 添加标签</button>
      {open ? (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
            <button className="modal-close icon-button" type="button" aria-label="关闭" onClick={() => setOpen(false)}>×</button>
            <p className="modal-eyebrow">PUZZLE TAGS</p>
            <h2 id="modalTitle">添加标签</h2>
            <p className="modal-intro">标签用于题库筛选；题型标签和状态标签可以同时存在。</p>
            <label className="form-field"><span>标签名称</span><input value={tag} onChange={(event) => setTag(event.target.value)} type="text" placeholder="例如：Sudoku" /></label>
            {error ? <p className="blank-result error">{error}</p> : null}
            <div className="modal-footer">
              <button className="button button-light" type="button" onClick={() => setOpen(false)}>取消</button>
              <button className="button button-dark" type="button" onClick={save}>保存标签</button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
