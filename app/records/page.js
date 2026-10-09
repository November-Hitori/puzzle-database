import RecordsView from '../../components/records/RecordsView.js';
import { getPuzzles } from '../../lib/data.js';

export const dynamic = 'force-dynamic';

export default async function RecordsPage() {
  const puzzles = await getPuzzles();
  return <RecordsView puzzles={puzzles} />;
}
