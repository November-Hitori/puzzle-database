import { buildPuzzleToolLinks } from './puzzle-tool-links.mjs';
import { hasConcretePuzzlePayload, parseTrustedPuzzleUrl } from './puzzle-url.mjs';

const form = document.querySelector('#embedDemoForm');
const input = document.querySelector('#embedDemoUrl');
const result = document.querySelector('#embedDemoResult');
const note = document.querySelector('#embedDemoNote');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[char]));

function renderDemo(url) {
  const links = buildPuzzleToolLinks(url);
  const trustedUrl = parseTrustedPuzzleUrl(url);
  if (!links.length || !trustedUrl) {
    result.innerHTML = `<div class="tool-launch-panel tool-launch-blocked" role="alert"><span class="tool-launch-kicker">BLOCKED</span><strong>该 URL 不受支持</strong><p>请使用 puzz.link、pzv3、pzprxs、pzplus 或 Penpa 系列的官方题目链接。</p></div>`;
  } else {
    const toolbar = `<div class="solver-toolbar"><div class="solver-toolbar-copy"><span class="tool-launch-kicker">IN-PAGE SOLVER</span><strong>页内解题</strong></div><div class="tool-link-list">${links.map((link) => `<a class="tool-link-button" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer"><span>${escapeHtml(link.name)}</span><strong>在新标签页解题 ↗</strong></a>`).join('')}</div></div>`;
    result.innerHTML = hasConcretePuzzlePayload(trustedUrl.href)
      ? `<div class="solver-shell">${toolbar}<div class="solver-frame"><iframe src="${escapeHtml(trustedUrl.href)}" title="PuzArchive solver demo"></iframe></div><p class="solver-note">若页内模块无法显示，可以使用上方按钮打开外部网站。</p></div>`
      : `<div class="solver-shell">${toolbar}<div class="solver-empty"><strong>该链接没有具体题面数据</strong><p>请使用上方工具按钮打开。</p></div></div>`;
  }
  note.innerHTML = `当前测试：<strong>${escapeHtml(url)}</strong>`;
  input.value = url;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  renderDemo(input.value.trim());
});

document.querySelectorAll('[data-demo-url]').forEach((button) => {
  button.addEventListener('click', () => renderDemo(button.dataset.demoUrl));
});

renderDemo(input.value);
