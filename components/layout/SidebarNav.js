"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navItems = [
  { href: '/calendar', label: '谜题日历', icon: '▤' },
  { href: '/rules', label: '规则', icon: '▥' },
  { href: '/inbox', label: '通知', icon: '◇' }
];

const personalItems = [
  { href: '/library', label: '旧版题库预览', icon: '⌂' },
  { href: '/records', label: '我的记录', icon: '✓', dot: true }
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
