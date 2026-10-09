import { buildPuzzleToolLinks } from '../../lib/puzzle-tool-links.mjs';
import { hasConcretePuzzlePayload, parseTrustedPuzzleUrl } from '../../lib/puzzle-url.mjs';
import BlankPuzzle from './BlankPuzzle.js';

export default function PuzzleSolverPanel({ puzzle }) {
  if (puzzle.inputMode === 'blank') return <BlankPuzzle puzzle={puzzle} />;

  const links = buildPuzzleToolLinks(puzzle.url);
  const trustedUrl = parseTrustedPuzzleUrl(puzzle.url);
  if (!links.length || !trustedUrl) {
    return (
      <div className="tool-launch-panel tool-launch-blocked" role="alert">
        <span className="tool-launch-kicker">BLOCKED</span>
        <strong>该链接不在支持的工具范围内</strong>
        <p>请使用 puzz.link、pzv3、pzprxs、pzplus 或 Penpa 系列的官方题目链接。</p>
      </div>
    );
  }

  const toolbar = (
    <div className="solver-toolbar">
      <div className="solver-toolbar-copy">
        <span className="tool-launch-kicker">IN-PAGE SOLVER</span>
        <strong>页内解题</strong>
      </div>
      <div className="tool-link-list">
        {links.map((link) => (
          <a className="tool-link-button" href={link.url} key={`${link.id}-${link.url}`} target="_blank" rel="noopener noreferrer">
            <span>{link.name}</span>
            <strong>在新标签页解题 ↗</strong>
          </a>
        ))}
      </div>
    </div>
  );

  if (!hasConcretePuzzlePayload(trustedUrl.href)) {
    return (
      <div className="solver-shell">
        {toolbar}
        <div className="solver-empty">
          <strong>这个示例还没有具体题面 URL</strong>
          <p>为避免加载网站首页文本，页内模块已停用。请使用上方工具按钮打开。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="solver-shell">
      {toolbar}
      <div className="solver-frame">
        <iframe src={trustedUrl.href} title={puzzle.title} />
      </div>
      <p className="solver-note">上方按钮会打开对应网站；当前模块直接在页面内加载原题。</p>
    </div>
  );
}
