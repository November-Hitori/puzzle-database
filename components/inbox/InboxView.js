"use client";

import { useRouter } from 'next/navigation';

export default function InboxView({ notifications }) {
  const router = useRouter();
  async function mark(id) { await fetch(id ? `/api/inbox/${id}/read` : '/api/inbox/read-all', { method: 'POST' }); router.refresh(); }
  return (
    <div className="page-wrap-inner"><section className="page-heading"><div><p className="eyebrow"><span className="eyebrow-line" />SYSTEM INBOX</p><h1>通知<span className="heading-period">.</span></h1><p className="page-description">规则审计和日历审核结果会显示在这里。</p></div><button className="button button-light" type="button" onClick={() => mark(null)}>全部标为已读</button></section><div className="record-list">{notifications.length ? notifications.map((item) => <div className={`record-row ${item.readAt ? '' : 'inbox-unread'}`} key={item.id}><span className="record-check">◇</span><span><strong>{item.title}</strong><small>{item.body}</small></span><button className="text-button" type="button" onClick={() => mark(item.id)}>{item.readAt ? '已读' : '标为已读'}</button></div>) : <div className="empty-state">暂无通知。</div>}</div></div>
  );
}
