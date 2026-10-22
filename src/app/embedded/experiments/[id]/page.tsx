import { EmbeddedExperimentHistory } from "../../experiment-history";

export default async function EmbeddedExperimentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EmbeddedExperimentHistory selectedId={decodeURIComponent(id)} />;
}
