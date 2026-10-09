"use client";

import { useEffect, useState } from 'react';
import { actions, useAppDispatch, useAppState } from '../../lib/state/app-store.js';
import NewFolderDialog from './NewFolderDialog.js';

const recentFiles = [
  ['Spring Selection', 'Logic Masters India / 2026', '08', '今天'],
  ['Paper & Pencil / Vol. 01', '日本パズル協会 / 2025', '24', '2 天前'],
  ['Example Puzzles', '个人收藏 / 2024', '12', '上周']
];

export default function FilesView({ initialFolders }) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [showNewFolder, setShowNewFolder] = useState(false);

  useEffect(() => {
    dispatch(actions.setFolders(initialFolders));
  }, [dispatch, initialFolders]);

  const folders = state.folders.length ? state.folders : initialFolders;

  return (
    <div className="page-wrap-inner">
      <section className="page-heading">
        <div><p className="eyebrow"><span className="eyebrow-line" />FILE MANAGER</p><h1>文件管理<span className="heading-period">.</span></h1><p className="page-description">把来源、年份和题集放进清晰的文件夹。</p></div>
        <button className="button button-dark" type="button" onClick={() => setShowNewFolder(true)}><span className="button-plus">+</span>新建文件夹</button>
      </section>
      <section className="file-toolbar">
        <div className="file-breadcrumb"><button type="button">全部文件</button></div>
        <div className="file-actions"><button className="button button-light" type="button">按最近更新</button><button className="icon-button bordered" type="button" title="列表视图">☷</button></div>
      </section>
      <section className="file-layout">
        <div className="file-main">
          <div className="file-section-heading"><span>FOLDERS</span><span>{folders.length} 个文件夹</span></div>
          <div className="folder-cards">
            {folders.map((folder) => <button className="folder-card" type="button" key={folder.id}><span className="folder-card-icon">▰</span><strong>{folder.name}</strong><small>{folder.count} puzzles <span>→</span></small></button>)}
            <button className="folder-card folder-card-new" type="button" onClick={() => setShowNewFolder(true)}><span>+</span><strong>新建文件夹</strong></button>
          </div>
          <div className="file-section-heading file-section-heading-spaced"><span>RECENT FILES</span><span>按最近修改</span></div>
          <div className="file-table">
            <div className="file-row file-head"><span>名称</span><span>位置</span><span>题目</span><span>更新</span></div>
            {recentFiles.map(([name, location, count, updated]) => <div className="file-row" key={name}><span className="file-name"><span className="file-mini-icon">▰</span><strong>{name}</strong></span><span className="muted">{location}</span><span>{count}</span><span className="muted">{updated}</span></div>)}
          </div>
        </div>
        <aside className="file-aside"><div className="file-aside-icon">⌘</div><h2>你的题目，<br /><em>有自己的位置。</em></h2><p>用来源、年份和题集整理资料。文件夹可以无限嵌套，之后也能随时移动。</p><div className="tree-mini"><span>⌄　▰ Logic Masters India</span><span>　⌄　▰ 2026</span><span>　　 ›　▰ Spring Selection</span></div></aside>
      </section>
      {showNewFolder ? <NewFolderDialog folders={folders} onClose={() => setShowNewFolder(false)} /> : null}
    </div>
  );
}
