"use client";

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { actions, useAppDispatch, useAppState } from '../../lib/state/app-store.js';

const labels = {
  '': '首页',
  library: '题库',
  puzzles: '题目',
  collections: '题集',
  files: '文件管理',
  records: '我的记录',
  authors: '作者'
};

export default function Topbar() {
  const pathname = usePathname();
  const router = useRouter();
  const dispatch = useAppDispatch();
  const { session } = useAppState();
  const segment = pathname.split('/').filter(Boolean)[0] || '';
  const current = labels[segment] || '首页';

  async function handleSearch() {
    const query = window.prompt('搜索题目、作者或标签');
    if (!query) return;
    try {
      const response = await fetch('/api/puzzles');
      const data = await response.json();
      const match = (data.puzzles || []).find((puzzle) =>
        `${puzzle.title} ${puzzle.author} ${(puzzle.tags || []).join(' ')}`
          .toLowerCase()
          .includes(query.toLowerCase())
      );
      router.push(match ? `/puzzles/${match.number}` : '/library');
    } catch {
      router.push('/library');
    }
  }

  return (
    <header className="topbar">
      <div className="breadcrumb">
        <span>Workspace</span>
        <span className="crumb-separator">/</span>
        <strong>{current}</strong>
      </div>
      <div className="top-actions">
        <button className="icon-button" type="button" title="搜索" aria-label="搜索" onClick={handleSearch}>⌕</button>
        <button className="icon-button" type="button" title="通知" aria-label="通知">
          <span className="notification-glyph">◇</span>
          <span className="notification-dot" />
        </button>
        {session ? <button className="login-button" type="button" onClick={async () => { await fetch('/api/session', { method: 'DELETE' }); dispatch(actions.setSession(null)); router.push('/login'); }}>{session.username || session.name} · 退出</button> : <Link className="login-button" href="/login">登录 <span>→</span></Link>}
      </div>
    </header>
  );
}
