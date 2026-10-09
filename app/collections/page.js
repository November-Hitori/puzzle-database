import CollectionList from '../../components/collections/CollectionList.js';
import { getCollections } from '../../lib/data.js';

export const dynamic = 'force-dynamic';

export default async function CollectionsPage() {
  const collections = await getCollections();
  return <CollectionList collections={collections} />;
}
