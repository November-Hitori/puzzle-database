import Link from 'next/link';

export default function RulesView({ rules }) {
  return (
    <div className="page-wrap-inner">
      <section className="page-heading"><div><p className="eyebrow"><span className="eyebrow-line" />RULE LIBRARY</p><h1>规则<span className="heading-period">.</span></h1><p className="page-description">规则按名称、说明和 Penpa 例题接受三名成员独立审计。</p></div><Link className="button button-dark" href="/rules/new"><span className="button-plus">+</span>新建规则</Link></section>
      <section className="library-section"><div className="section-heading compact"><div className="section-title-group"><h2>全部规则</h2><span className="count-badge">{String(rules.length).padStart(2, '0')}</span></div></div><div className="collection-puzzle-list">{rules.map((rule) => <Link className="collection-puzzle-row" href={`/rules/${rule.id}`} key={rule.id}><span className="collection-puzzle-number">#{rule.id}</span><span><strong>{rule.titleZh || rule.titleEn}</strong><small>{rule.category} · {rule.isVariant ? '变体' : '原规则'}</small></span><span className="collection-puzzle-status">{rule.qualityErrors?.length ? '需完善' : '可审计'}</span></Link>)}</div></section>
    </div>
  );
}
