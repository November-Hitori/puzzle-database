import './design-system.css';
import './globals.css';
import AppShell from '../components/layout/AppShell.js';

export const metadata = {
  title: 'PuzArchive',
  description: 'Puzzle database built with Next.js'
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
