import SidebarNav from './SidebarNav.js';
import Topbar from './Topbar.js';
import ToastViewport from '../ui/ToastViewport.js';
import { AppStateProvider } from '../../lib/state/app-store.js';

export default function AppShell({ children }) {
  return (
    <AppStateProvider>
    <div className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <a className="brand" href="/" aria-label="PuzArchive 首页">
          <span className="brand-mark">PA</span>
          <span>
            <strong>PuzArchive</strong>
            <small>puzzle database</small>
          </span>
        </a>
        <SidebarNav />
        <div className="sidebar-bottom">
          <div className="sync-status">
            <span className="status-light" />
            <span>本地演示数据</span>
            <span className="mono">v0.2</span>
          </div>
          <button className="profile-chip" type="button">
            <span className="avatar avatar-amber">L</span>
            <span className="profile-copy">
              <strong>Lin</strong>
              <small>Guest account</small>
            </span>
            <span className="profile-more">···</span>
          </button>
        </div>
      </aside>
      <main className="main-content" id="top">
        <Topbar />
        <div className="page-wrap">{children}</div>
      </main>
    </div>
    <ToastViewport />
    </AppStateProvider>
  );
}
