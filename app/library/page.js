import LibraryView from '../../components/puzzles/LibraryView.js';
import { getPuzzles } from '../../lib/data.js';

export const dynamic = 'force-dynamic';

export default async function LibraryPage() {
  const puzzles = await getPuzzles();
  return <LibraryView initialPuzzles={puzzles} />;
}
