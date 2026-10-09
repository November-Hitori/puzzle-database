"use client";

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { actions, useAppDispatch } from '../../lib/state/app-store.js';

export default function LoginForm() {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
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
      <p className="eyebrow"><span className="eyebrow-line" />PRIVATE WORKSPACE</p>
      <h1>登录<span className="heading-period">.</span></h1>
      <p className="page-description">使用共享邀请注册的账号登录日历工作区。</p>
      <label className="form-field"><span>用户名</span><input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
      <label className="form-field"><span>密码</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      {error ? <p className="blank-result error">{error}</p> : null}
      <div className="auth-actions"><button className="button button-dark" type="submit" disabled={submitting}>{submitting ? '登录中…' : '登录'}</button><Link href="/register">使用邀请码注册</Link></div>
    </form>
  );
}
