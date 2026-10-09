"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function RuleEditor({ rules = [], initial = null }) {
  const router = useRouter();
  const [form, setForm] = useState({
    titleZh: initial?.titleZh || '', titleEn: initial?.titleEn || '', rulesZh: (initial?.rulesZh || []).join('\n'), rulesEn: (initial?.rulesEn || []).join('\n'), category: initial?.category || '其它', isVariant: initial?.isVariant || false, baseRuleId: initial?.baseRuleId || '', exampleUrl: initial?.exampleUrl || '', exampleAuthor: initial?.exampleAuthor || ''
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function update(key, value) { setForm((current) => ({ ...current, [key]: value })); }

  async function submit(event) {
    event.preventDefault(); setSubmitting(true); setError('');
    try {
      const response = await fetch('/api/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, rulesZh: form.rulesZh.split('\n').map((line) => line.trim()).filter(Boolean), rulesEn: form.rulesEn.split('\n').map((line) => line.trim()).filter(Boolean), baseRuleId: form.baseRuleId || null }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      router.push(`/rules/${data.rule.id}`); router.refresh();
    } catch (submitError) { setError(submitError.message); } finally { setSubmitting(false); }
  }

  return (
    <form className="auth-card rule-editor" onSubmit={submit}>
      <p className="eyebrow"><span className="eyebrow-line" />RULE DRAFT</p><h1>新建规则<span className="heading-period">.</span></h1>
      <label className="form-field"><span>中文名称</span><input value={form.titleZh} onChange={(event) => update('titleZh', event.target.value)} /></label>
      <label className="form-field"><span>英文名称</span><input value={form.titleEn} onChange={(event) => update('titleEn', event.target.value)} /></label>
      <label className="form-field"><span>分类</span><select value={form.category} onChange={(event) => update('category', event.target.value)}>{['涂黑','填数','分区','置物','路径','其它'].map((value) => <option key={value}>{value}</option>)}</select></label>
      <label className="form-field"><span>中文说明，每行一条</span><textarea value={form.rulesZh} onChange={(event) => update('rulesZh', event.target.value)} /></label>
      <label className="form-field"><span>英文说明，可选，每行一条</span><textarea value={form.rulesEn} onChange={(event) => update('rulesEn', event.target.value)} /></label>
      <label className="form-field form-check"><input type="checkbox" checked={form.isVariant} onChange={(event) => update('isVariant', event.target.checked)} />这是变体规则</label>
      {form.isVariant ? <label className="form-field"><span>基础规则</span><select value={form.baseRuleId} onChange={(event) => update('baseRuleId', event.target.value)}><option value="">请选择</option>{rules.filter((rule) => !rule.isVariant).map((rule) => <option value={rule.id} key={rule.id}>{rule.titleZh || rule.titleEn}</option>)}</select></label> : null}
      <label className="form-field"><span>Penpa 例题 URL</span><input value={form.exampleUrl} onChange={(event) => update('exampleUrl', event.target.value)} /></label>
      <label className="form-field"><span>例题作者</span><input value={form.exampleAuthor} onChange={(event) => update('exampleAuthor', event.target.value)} /></label>
      {error ? <p className="blank-result error">{error}</p> : null}
      <div className="auth-actions"><button className="button button-dark" type="submit" disabled={submitting}>{submitting ? '保存中…' : '保存规则'}</button></div>
    </form>
  );
}
