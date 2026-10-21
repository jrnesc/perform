import { ExperimentHistory } from "../../../embedded/experiment-history";

export default async function PreviewExperimentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ExperimentHistory preview selectedId={decodeURIComponent(id)} />;
}
