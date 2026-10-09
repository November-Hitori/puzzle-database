import FilesView from '../../components/files/FilesView.js';
import { getFolders } from '../../lib/data.js';

export const dynamic = 'force-dynamic';

export default async function FilesPage() {
  const folders = await getFolders();
  return <FilesView initialFolders={folders} />;
}
