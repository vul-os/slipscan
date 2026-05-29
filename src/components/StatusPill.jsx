import { Badge } from "@/components/ui/Badge";

const map = {
  pending:    { tone: "warning", label: "Queued" },
  processing: { tone: "warning", label: "Extracting…" },
  extracted:  { tone: "success", label: "Extracted" },
  failed:     { tone: "danger",  label: "Failed" },
  verified:   { tone: "success", label: "Verified" },
  rejected:   { tone: "danger",  label: "Rejected" },
};

export function StatusPill({ status }) {
  const { tone, label } = map[status] ?? { tone: "neutral", label: status || "Unknown" };
  return <Badge tone={tone} dot>{label}</Badge>;
}
