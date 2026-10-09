import { notFound } from 'next/navigation';
import CollectionDetail from '../../../components/collections/CollectionDetail.js';
import { getCollection } from '../../../lib/data.js';

export const dynamic = 'force-dynamic';

export default async function CollectionPage({ params }) {
  const { id } = await params;
  const collection = await getCollection(Number(id));
  if (!collection) notFound();
  return <CollectionDetail collection={collection} />;
}
