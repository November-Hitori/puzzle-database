import RuleEditor from '../../../components/rules/RuleEditor.js';
import { requireSessionUser } from '../../../lib/server/session.js';
import { getRules } from '../../../lib/data.js';

export const dynamic = 'force-dynamic';
export default async function NewRulePage() { const user = await requireSessionUser(); const rules = await getRules(user.id); return <div className="page-wrap-inner auth-page"><RuleEditor rules={rules} /></div>; }
