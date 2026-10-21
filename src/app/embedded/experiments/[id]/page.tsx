import { ExperimentHistory } from "../../experiment-history";

export default async function EmbeddedExperimentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ExperimentHistory preview={false} selectedId={decodeURIComponent(id)} />;
}
