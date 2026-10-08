import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.dirname(fileURLToPath(import.meta.url));
export function getPenpaGuidelines() {
  // The workspace specification takes precedence; packaged deployments use docs/penpa.md.
  const files = process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH ? [process.env.PUZARCHIVE_PENPA_GUIDELINES_PATH] : [path.join(root,'..','docs','penpa.md'),path.join(root,'docs','penpa.md')];
  for (const file of files) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file,'utf8').trim();
      if (text) return {available:true,text,revision:createHash('sha256').update(text).digest('hex')};
    }
  }
  return {available:false,text:'Penpa 制图规范正文尚未提供，请维护者补充 docs/penpa.md。',revision:''};
}
