import { Badge } from "@/components/ui/Badge";

const map = {
  pending:  { tone: "warning", label: "Pending" },
  verified: { tone: "success", label: "Verified" },
  rejected: { tone: "danger",  label: "Rejected" },
};

export function StatusPill({ status }) {
  const { tone, label } = map[status] ?? map.pending;
  return <Badge tone={tone} dot>{label}</Badge>;
}
