"use client";

import { useEffect } from 'react';
import { actions, useAppDispatch } from '../../lib/state/app-store.js';

export default function SessionBootstrap() {
  const dispatch = useAppDispatch();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/session')
      .then((response) => response.ok ? response.json() : { user: null })
      .then((data) => {
        if (!cancelled) dispatch(actions.setSession(data.user || null));
      })
      .catch(() => {
        if (!cancelled) dispatch(actions.setSession(null));
      });
    return () => { cancelled = true; };
  }, [dispatch]);

  return null;
}
