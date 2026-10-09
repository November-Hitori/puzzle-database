import Link from 'next/link';
import { notFound } from 'next/navigation';
import RuleAuditPanel from '../../../components/rules/RuleAuditPanel.js';
import { requireSessionUser } from '../../../lib/server/session.js';
import { getRule } from '../../../lib/data.js';

export const dynamic = 'force-dynamic';
export default async function RulePage({ params }) { const user = await requireSessionUser(); const { id } = await params; const rule = await getRule(Number(id), user.id); if (!rule) notFound(); return <div className="page-wrap-inner"><Link className="back-link" href="/rules">← 返回规则</Link><section className="puzzle-header"><div><p className="eyebrow"><span className="eyebrow-line" />RULE #{rule.id}</p><h1>{rule.titleZh || rule.titleEn}<span className="heading-period">.</span></h1><p className="puzzle-meta-large">{rule.category} · {rule.isVariant ? '变体规则' : '原规则'}</p></div></section><div className="collection-detail-grid"><div><div className="detail-block"><h3>说明</h3><p>{(rule.rulesZh || []).join(' ')}</p></div><div className="detail-block"><h3>英文说明</h3><p>{(rule.rulesEn || []).join(' ') || '暂无'}</p></div></div><aside><div className="detail-block"><h3>例题</h3><p>{rule.exampleUrl || '暂无'}</p><p>{rule.exampleAuthor || ''}</p></div><RuleAuditPanel rule={rule} /></aside></div></div>; }
