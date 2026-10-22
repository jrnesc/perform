import EmbeddedPage from "../page";

export default async function EmbeddedNewExperimentPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { resume, workspace } = await searchParams;
  return (
    <EmbeddedPage
      screen="setup"
      resume={
        typeof resume === "string" && (workspace === "real" || workspace === "demo")
          ? { experimentId: resume, workspace }
          : undefined
      }
    />
  );
}
