import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.dirname(fileURLToPath(import.meta.url));
const bundledFile = path.join(root,'docs','penpa.md');
const legacyBundledRevision = '0cf20a8109af013b5570786483d0571355adebac585c9b4a79144f6a6ccb1a5d';
const hash = (text) => createHash('sha256').update(text).digest('hex');
export function getPenpaGuidelines() {
  // The workspace specification takes precedence; packaged deployments use docs/penpa.md.
  const files = process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH ? [process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH] : [path.join(root,'..','docs','penpa.md'),bundledFile];
  for (const file of files) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file,'utf8').trim();
      if (text) {
        let revision = hash(text);
        // The bundled specification was one line. Preserve its audit version for
        // this whitespace-only reformat; custom and changed specifications keep exact hashes.
        if (!process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH && file === bundledFile
          && hash(text.replace(/\s+/g,' ')) === legacyBundledRevision) revision = legacyBundledRevision;
        return {available:true,text,revision};
      }
    }
  }
  return {available:false,text:'Penpa 制图规范正文尚未提供，请维护者补充 docs/penpa.md。',revision:''};
}
