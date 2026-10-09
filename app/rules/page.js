import RulesView from '../../components/rules/RulesView.js';
import { requireSessionUser } from '../../lib/server/session.js';
import { getRules } from '../../lib/data.js';

export const dynamic = 'force-dynamic';
export default async function RulesPage() { const user = await requireSessionUser(); const rules = await getRules(user.id); return <RulesView rules={rules} />; }
