"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const items = [['name','名称'],['description','说明'],['example','例题']];

export default function RuleAuditPanel({ rule }) {
  const router = useRouter();
  const [suggestion, setSuggestion] = useState('');
  const [error, setError] = useState('');

  async function vote(item, decision, revision) {
    setError('');
    const response = await fetch(`/api/rules/${rule.id}/audits`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item, decision, revision, suggestion }) });
    const data = await response.json(); if (!response.ok) return setError(data.error || `HTTP ${response.status}`); setSuggestion(''); router.refresh();
  }

  return (
    <div className="detail-block record-panel">
      <h3>规则审计</h3>
      <p className="record-help">名称、说明和例题分别需要三名不同成员通过。</p>
      {items.map(([item, label]) => <div className="rule-audit-row" key={item}><strong>{label}</strong><span>版本 {rule.revisions?.[item] || 1}</span><div><button className="button button-light" type="button" onClick={() => vote(item, 'reject', rule.revisions?.[item] || 1)}>拒绝</button><button className="button button-dark" type="button" onClick={() => vote(item, 'approve', rule.revisions?.[item] || 1)}>通过</button></div></div>)}
      <label className="form-field"><span>建议（可选）</span><textarea value={suggestion} onChange={(event) => setSuggestion(event.target.value)} /></label>
      {error ? <p className="blank-result error">{error}</p> : null}
    </div>
  );
}
