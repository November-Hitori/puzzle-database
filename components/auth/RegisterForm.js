"use client";

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { actions, useAppDispatch } from '../../lib/state/app-store.js';

export default function RegisterForm() {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const [form, setForm] = useState({ username: '', password: '', inviteCode: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      dispatch(actions.setSession(data.user));
      router.push('/calendar');
      router.refresh();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-card" onSubmit={submit}>
      <p className="eyebrow"><span className="eyebrow-line" />SHARED INVITATION</p>
      <h1>注册<span className="heading-period">.</span></h1>
      <p className="page-description">共享邀请码可供多名成员注册，每个账号拥有独立身份。</p>
      <label className="form-field"><span>共享邀请码</span><input value={form.inviteCode} onChange={(event) => update('inviteCode', event.target.value)} /></label>
      <label className="form-field"><span>用户名</span><input autoComplete="username" value={form.username} onChange={(event) => update('username', event.target.value)} /></label>
      <label className="form-field"><span>密码</span><input type="password" autoComplete="new-password" value={form.password} onChange={(event) => update('password', event.target.value)} /></label>
      <p className="form-help">用户名 2–32 字符；密码 12–128 字符且不超过 512 UTF-8 字节。</p>
      {error ? <p className="blank-result error">{error}</p> : null}
      <div className="auth-actions"><button className="button button-dark" type="submit" disabled={submitting}>{submitting ? '注册中…' : '注册并登录'}</button><Link href="/login">已有账号</Link></div>
    </form>
  );
}
