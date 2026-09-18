import { Badge, Card, EmptyState, ErrorNotice, PageHeader, Table } from "@/components/ui";
import { ApiRequestError, api } from "@/lib/api";
import { dateTime, riskTone, titleCase } from "@/lib/format";

export const dynamic = "force-dynamic";

interface Assessment {
  opportunity_id: number | null;
  order_id: number | null;
  score: number;
  level: string;
  is_blocking: boolean;
  blockers: string[];
  reasons: string[];
  assessed_at: string;
}

export default async function RiskPage() {
  let risk;
  try {
    risk = await api.risk();
  } catch (error) {
    return <ErrorNotice title="Could not load risk data" message={error instanceof ApiRequestError ? error.message : String(error)} />;
  }

  const assessments = risk.recent_assessments as unknown as Assessment[];

  return (
    <>
      <PageHeader
        title="Risk"
        description={`Deterministic and reproducible. Model version ${risk.risk_model_version}. No language model participates in the score.`}
      />

      <Card title="Distribution">
        <div className="grid grid-cols-5 gap-2">
          {Object.entries(risk.distribution).map(([level, count]) => (
            <div key={level} className="rounded border border-border p-3 text-center">
              <p className="text-xs text-ink-muted">{level}</p>
              <p className="numeric mt-1 text-xl font-semibold">{count}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Recent assessments" subtitle="Each score is explained by its factors">
        {assessments.length === 0 ? (
          <EmptyState title="Nothing scored yet" body="Risk assessments appear once opportunities are evaluated." />
        ) : (
          <Table head={["When", "Entity", "Score", "Level", "Blocking", "Top reasons"]}>
            {assessments.map((assessment, index) => (
              <tr key={`${assessment.assessed_at}-${index}`}>
                <td className="px-3 py-2 text-xs text-ink-muted">{dateTime(assessment.assessed_at)}</td>
                <td className="px-3 py-2 text-xs">
                  {assessment.opportunity_id ? `Opportunity ${assessment.opportunity_id}` : `Order ${assessment.order_id}`}
                </td>
                <td className="px-3 py-2"><Badge tone={riskTone(assessment.score)}>{assessment.score}</Badge></td>
                <td className="px-3 py-2 text-xs">{titleCase(assessment.level)}</td>
                <td className="px-3 py-2">
                  {assessment.is_blocking ? <Badge tone="negative">Blocked</Badge> : <Badge tone="positive">No</Badge>}
                </td>
                <td className="px-3 py-2 text-xs text-ink-muted">
                  {(assessment.blockers.length > 0 ? assessment.blockers : assessment.reasons).slice(0, 2).join("; ")}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
