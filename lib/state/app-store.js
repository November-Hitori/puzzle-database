"use client";

import { createContext, useContext, useReducer } from 'react';

const initialState = {
  puzzles: [],
  folders: [],
  collections: [],
  tags: [],
  session: null,
  toasts: []
};

const AppStateContext = createContext(null);

function reducer(state, action) {
  switch (action.type) {
    case 'puzzles/set':
      return { ...state, puzzles: action.payload };
    case 'folders/set':
      return { ...state, folders: action.payload };
    case 'collections/set':
      return { ...state, collections: action.payload };
    case 'tags/set':
      return { ...state, tags: action.payload };
    case 'session/set':
      return { ...state, session: action.payload };
    case 'toast/push':
      return { ...state, toasts: [...state.toasts, { id: `${Date.now()}-${Math.random()}`, message: action.payload }] };
    case 'toast/dismiss':
      return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.payload) };
    default:
      return state;
  }
}

export const actions = {
  setPuzzles: (payload) => ({ type: 'puzzles/set', payload }),
  setFolders: (payload) => ({ type: 'folders/set', payload }),
  setCollections: (payload) => ({ type: 'collections/set', payload }),
  setTags: (payload) => ({ type: 'tags/set', payload }),
  setSession: (payload) => ({ type: 'session/set', payload }),
  pushToast: (message) => ({ type: 'toast/push', payload: message }),
  dismissToast: (id) => ({ type: 'toast/dismiss', payload: id })
};

export function AppStateProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  return <AppStateContext.Provider value={{ state, dispatch }}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const context = useContext(AppStateContext);
  if (!context) throw new Error('useAppState must be used inside AppStateProvider');
  return context.state;
}

export function useAppDispatch() {
  const context = useContext(AppStateContext);
  if (!context) throw new Error('useAppDispatch must be used inside AppStateProvider');
  return context.dispatch;
}
