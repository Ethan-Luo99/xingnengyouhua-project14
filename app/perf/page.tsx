import Dashboard from "./dashboard";

export default async function PerfPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const params = await searchParams;
  const filter = typeof params.q === "string" ? params.q : "";
  return (
    <main>
      <h1>Metrics Dashboard</h1>
      <Dashboard filter={filter} />
    </main>
  );
}
