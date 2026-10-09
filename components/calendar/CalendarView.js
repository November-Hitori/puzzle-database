"use client";

import Link from 'next/link';
import { useState } from 'react';
import NewCalendarPuzzleDialog from './NewCalendarPuzzleDialog.js';

export default function CalendarView({ puzzles, leftovers, rules, currentUser }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="page-wrap-inner">
      <section className="page-heading"><div><p className="eyebrow"><span className="eyebrow-line" />CALENDAR REVIEW</p><h1>谜题日历<span className="heading-period">.</span></h1><p className="page-description">提交投稿、完成评价，并跟踪每一轮支持和否决结果。</p></div><button className="button button-dark" type="button" onClick={() => setAdding(true)} disabled={!rules.length}><span className="button-plus">+</span>提交日历谜题</button></section>
      <section className="overview-grid"><div className="stat-block"><span className="stat-label">当前投稿</span><strong>{puzzles.length}</strong></div><div className="stat-block"><span className="stat-label">待重新进入</span><strong>{leftovers.length}</strong></div><div className="stat-block"><span className="stat-label">登录成员</span><strong>{currentUser.username || currentUser.name}</strong></div></section>
      <section className="library-section"><div className="section-heading compact"><div className="section-title-group"><h2>当前轮次</h2><span className="count-badge">{String(puzzles.length).padStart(2, '0')}</span></div></div><div className="collection-puzzle-list">{puzzles.map((puzzle) => <Link className="collection-puzzle-row" href={`/calendar/${puzzle.number}`} key={puzzle.number}><span className="collection-puzzle-number">#{puzzle.number}</span><span><strong>{puzzle.title}</strong><small>{puzzle.author} · 第 {puzzle.reviewRound} 轮 · {puzzle.calendarStatus}</small></span><span className="collection-puzzle-status">{puzzle.completed ? '已评价' : '待评价'}</span></Link>)}</div></section>
      {leftovers.length ? <section className="library-section"><div className="section-heading compact"><h2>待重新进入</h2></div><div className="collection-puzzle-list">{leftovers.map((puzzle) => <Link className="collection-puzzle-row" href={`/calendar/${puzzle.number}`} key={puzzle.number}><span className="collection-puzzle-number">#{puzzle.number}</span><span><strong>{puzzle.title}</strong><small>第 {puzzle.reviewRound} 轮已归档</small></span><span className="collection-puzzle-status">待处理</span></Link>)}</div></section> : null}
      {!rules.length ? <p className="notice-strip">请先创建至少一条规则，才能提交日历谜题。</p> : null}
      {adding ? <NewCalendarPuzzleDialog rules={rules} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
