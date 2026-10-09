"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { actions, useAppDispatch } from '../../lib/state/app-store.js';

export default function NewFolderDialog({ folders, onClose }) {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [error, setError] = useState('');

  async function save() {
    if (!name.trim()) return setError('请填写文件夹名称');
    const response = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), parentId: parentId || null })
    });
    const data = await response.json();
    if (!response.ok) return setError(data.error || `HTTP ${response.status}`);
    dispatch(actions.setFolders(data.folders));
    dispatch(actions.pushToast('文件夹已创建'));
    onClose();
    router.refresh();
  }

  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <button className="modal-close icon-button" type="button" aria-label="关闭" onClick={onClose}>×</button>
        <p className="modal-eyebrow">FILE MANAGER</p>
        <h2 id="modalTitle">新建文件夹</h2>
        <p className="modal-intro">文件夹可以表示来源、年份或题集，并且可以继续嵌套。</p>
        <label className="form-field"><span>文件夹名称</span><input value={name} onChange={(event) => setName(event.target.value)} type="text" placeholder="例如：2026" /></label>
        <label className="form-field"><span>上级文件夹（可选）</span><select value={parentId} onChange={(event) => setParentId(event.target.value)}><option value="">根目录</option>{folders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}</select></label>
        {error ? <p className="blank-result error">{error}</p> : null}
        <div className="modal-footer"><button className="button button-light" type="button" onClick={onClose}>取消</button><button className="button button-dark" type="button" onClick={save}>创建文件夹</button></div>
      </section>
    </div>
  );
}
