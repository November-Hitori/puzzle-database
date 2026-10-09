"use client";

import { useEffect, useMemo, useState } from 'react';
import { actions, useAppDispatch, useAppState } from '../../lib/state/app-store.js';
import PuzzleRow from './PuzzleRow.js';
import AddPuzzleDialog from './AddPuzzleDialog.js';

const filters = [
  ['all', '全部'],
  ['logic', '逻辑题'],
  ['word', '文字题'],
  ['completed', '已完成'],
  ['wrong', 'Wrong Puzzle']
];

export default function LibraryView({ initialPuzzles }) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [sort, setSort] = useState('recent');
  const [filter, setFilter] = useState('all');
  const [visible, setVisible] = useState(6);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    dispatch(actions.setPuzzles(initialPuzzles));
  }, [dispatch, initialPuzzles]);

  const puzzles = state.puzzles.length ? state.puzzles : initialPuzzles;

  const filtered = useMemo(() => {
    const result = puzzles.filter((puzzle) => {
      if (filter === 'completed') return puzzle.completed;
      if (filter === 'wrong') return (puzzle.tags || []).includes('Wrong Puzzle');
      if (filter === 'logic') return puzzle.type === '逻辑题';
      if (filter === 'word') return puzzle.type === '文字题';
      return true;
    });
    return result.sort((a, b) => sort === 'rating'
      ? Number(b.ratings?.[2] || 0) - Number(a.ratings?.[2] || 0)
      : Number(b.number) - Number(a.number));
  }, [filter, puzzles, sort]);

  const visiblePuzzles = filtered.slice(0, visible);
  const completed = puzzles.filter((puzzle) => puzzle.completed).length;
  const completionPercent = puzzles.length ? Math.round((completed / puzzles.length) * 100) : 0;

  return (
    <div className="page-wrap-inner">
      <section className="page-heading">
        <div>
          <p className="eyebrow"><span className="eyebrow-line" />PUZZLE LIBRARY</p>
          <h1>题库<span className="heading-period">.</span></h1>
        </div>
        <button className="button button-dark" type="button" onClick={() => setAdding(true)}>
          <span className="button-plus">+</span>添加题目
        </button>
      </section>

      <section className="notice-strip" aria-label="公告">
        <div className="notice-symbol">✦</div>
        <div className="notice-copy">
          <span className="notice-kicker">公告 · NEXT.JS MIGRATION</span>
          <strong>题库已迁移到 App Router</strong>
          <span>现有筛选、排序和新增题目流程继续保留。</span>
        </div>
      </section>

      <section className="overview-grid" aria-label="题库概览">
        <div className="stat-block"><span className="stat-label">全部题目</span><strong>{puzzles.length}</strong><span className="stat-meta positive">Next.js <em>data layer</em></span></div>
        <div className="stat-block"><span className="stat-label">已完成</span><strong>{completed}</strong><span className="stat-meta"><span className="mini-bar"><i style={{ width: `${completionPercent}%` }} /></span>{completionPercent}% of library</span></div>
        <div className="stat-block stat-block-wide"><span className="stat-label">评分机制</span><div className="activity-line"><span className="rating-legend">✎ 逻辑难度　♧ 通灵难度　♥ 喜爱程度</span></div></div>
      </section>

      <section className="library-section">
        <div className="section-heading">
          <div className="section-title-group"><h2>所有题目</h2><span className="count-badge">{String(filtered.length).padStart(2, '0')}</span></div>
          <div className="view-controls">
            <div className="segmented-control" role="tablist" aria-label="题目排序">
              {[['recent', '最近添加'], ['number', '题号'], ['rating', '评分']].map(([value, label]) => (
                <button className={`segment ${sort === value ? 'active' : ''}`} key={value} type="button" onClick={() => setSort(value)}>{label}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="filter-row">
          <span className="filter-caption">FILTER BY</span>
          {filters.map(([value, label]) => (
            <button className={`filter-pill ${filter === value ? 'active' : ''}`} data-filter={value} key={value} type="button" onClick={() => { setFilter(value); setVisible(6); }}>{label}</button>
          ))}
        </div>
        <div className="puzzle-table" role="table" aria-label="谜题列表">
          <div className="table-head" role="row">
            <span className="cell-number">NO.</span><span className="cell-puzzle">PUZZLE</span><span className="cell-author">AUTHOR</span><span className="cell-tags">TAGS</span><span className="cell-rating">AVERAGE RATING</span><span className="cell-action" />
          </div>
          <div>{visiblePuzzles.map((puzzle) => <PuzzleRow key={puzzle.number} puzzle={puzzle} />)}</div>
        </div>
        <div className="table-footer">
          <span>显示 <strong>{visiblePuzzles.length}</strong> / {filtered.length} 道题目</span>
          {visible < filtered.length ? <button className="text-button" type="button" onClick={() => setVisible((value) => value + 6)}>加载更多 <span>↓</span></button> : null}
        </div>
      </section>
      {adding ? <AddPuzzleDialog onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
