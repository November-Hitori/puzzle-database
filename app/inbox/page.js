import InboxView from '../../components/inbox/InboxView.js';
import { requireSessionUser } from '../../lib/server/session.js';
import { getInbox } from '../../lib/data.js';

export const dynamic = 'force-dynamic';
export default async function InboxPage() { const user = await requireSessionUser(); const inbox = await getInbox(user.id, { limit: 30 }); return <InboxView notifications={inbox.notifications || []} />; }
