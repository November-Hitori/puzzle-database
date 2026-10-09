import AuthorsView from '../../components/authors/AuthorsView.js';
import { getPuzzles } from '../../lib/data.js';

export const dynamic = 'force-dynamic';

export default async function AuthorsPage() {
  const puzzles = await getPuzzles();
  return <AuthorsView puzzles={puzzles} />;
}
