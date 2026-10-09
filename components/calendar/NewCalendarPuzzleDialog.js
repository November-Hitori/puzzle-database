"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { parseTrustedPuzzleUrl } from '../../lib/puzzle-url.mjs';

export default function NewCalendarPuzzleDialog({ rules, onClose }) {
  const router = useRouter();
  const currentYear = new Date().getFullYear();
  const [form, setForm] = useState({ title: '', source: '', url: '', ruleId: rules[0]?.id || '', inputMode: 'external', notes: '', suggestedMonthDay: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setError('');
    if (!form.title.trim() || !form.source.trim() || !form.ruleId) return setError('标题、来源和规则为必填项');
    if (form.inputMode === 'external' && !parseTrustedPuzzleUrl(form.url)) return setError('外部题目链接无效');
    setSubmitting(true);
    try {
      const response = await fetch('/api/calendar/puzzles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, note: form.notes, calendarYear: currentYear + 1 })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      onClose();
      router.refresh();
      if (data.puzzle) router.push(`/calendar/${data.puzzle.number}`);
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <button className="modal-close icon-button" type="button" onClick={onClose}>×</button>
        <form onSubmit={submit}>
          <p className="modal-eyebrow">CALENDAR SUBMISSION</p><h2 id="modalTitle">提交日历谜题</h2>
          <label className="form-field"><span>题目标题</span><input value={form.title} onChange={(event) => update('title', event.target.value)} /></label>
          <label className="form-field"><span>来源</span><input value={form.source} onChange={(event) => update('source', event.target.value)} placeholder="puzz.link" /></label>
          <label className="form-field"><span>规则</span><select value={form.ruleId} onChange={(event) => update('ruleId', event.target.value)}><option value="">请选择规则</option>{rules.map((rule) => <option value={rule.id} key={rule.id}>{rule.titleZh || rule.titleEn}</option>)}</select></label>
          <label className="form-field"><span>类型</span><select value={form.inputMode} onChange={(event) => update('inputMode', event.target.value)}><option value="external">外部题目</option><option value="blank">填空题</option></select></label>
          {form.inputMode === 'external' ? <label className="form-field"><span>题目链接</span><input value={form.url} onChange={(event) => update('url', event.target.value)} /></label> : null}
          <label className="form-field"><span>建议月日（可选）</span><input value={form.suggestedMonthDay} onChange={(event) => update('suggestedMonthDay', event.target.value)} placeholder="MM-DD" /></label>
          <label className="form-field"><span>备注</span><textarea value={form.notes} onChange={(event) => update('notes', event.target.value)} /></label>
          {error ? <p className="blank-result error">{error}</p> : null}
          <div className="modal-footer"><button className="button button-light" type="button" onClick={onClose}>取消</button><button className="button button-dark" type="submit" disabled={submitting}>{submitting ? '提交中…' : '提交'}</button></div>
        </form>
      </section>
    </div>
  );
}
