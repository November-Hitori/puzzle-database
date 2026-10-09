"use client";

import { useEffect } from 'react';
import { actions, useAppDispatch, useAppState } from '../../lib/state/app-store.js';

function ToastItem({ toast }) {
  const dispatch = useAppDispatch();

  useEffect(() => {
    const timer = window.setTimeout(() => dispatch(actions.dismissToast(toast.id)), 2600);
    return () => window.clearTimeout(timer);
  }, [dispatch, toast.id]);

  return <div className="next-toast">{toast.message}</div>;
}

export default function ToastViewport() {
  const { toasts } = useAppState();
  return <div className="next-toast-stack" role="status" aria-live="polite">{toasts.map((toast) => <ToastItem key={toast.id} toast={toast} />)}</div>;
}
