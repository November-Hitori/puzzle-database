"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navItems = [
  { href: '/', label: '首页', icon: '⌂', exact: true },
  { href: '/library', label: '题库', icon: '▤', count: 128 },
  { href: '/collections', label: '题集列表', icon: '▥' },
  { href: '/files', label: '文件管理', icon: '⌘' }
];

const personalItems = [
  { href: '/records', label: '我的记录', icon: '✓', dot: true },
  { href: '/authors', label: '作者', icon: '◊' }
];

function isActive(pathname, href, exact = false) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function SidebarNav() {
  const pathname = usePathname();

  const renderItem = (item, personal = false) => (
    <Link
      key={item.href}
      className={`nav-item ${isActive(pathname, item.href, item.exact) ? 'active' : ''}`}
      href={item.href}
    >
      <span className="nav-icon">{item.icon}</span>
      <span>{item.label}</span>
      {item.count ? <span className="nav-count">{item.count}</span> : null}
      {personal && item.dot ? <span className="nav-dot" /> : null}
    </Link>
  );

  return (
    <nav className="primary-nav">
      <p className="nav-label">Workspace</p>
      {navItems.map((item) => renderItem(item))}
      <p className="nav-label nav-label-spaced">Personal</p>
      {personalItems.map((item) => renderItem(item, true))}
    </nav>
  );
}
