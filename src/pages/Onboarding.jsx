// P2-01: Onboarding by org kind (personal vs business).
// Step 1 → choose kind (deliberate — kind is effectively immutable).
// Step 2 → conditional profile form with zod validation.
// Step 3 → confirmation with inbound email address.
// "Join with invite" tab is preserved from before.

import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Building2, Mail, User, Check, Copy } from "lucide-react";
import { Wordmark } from "@/components/Wordmark";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { FormField } from "@/components/ui/FormField";
import { useAcceptInvitation, useCreateOrg } from "@/lib/queries";
import { useOrgStore } from "@/stores/org";
import { cn } from "@/lib/cn";

// Inbound email domain — falls back to a placeholder when not configured.
const RX_DOMAIN = import.meta.env.VITE_RX_DOMAIN || null;

// ── Zod schemas ──────────────────────────────────────────────────────────────

const personalSchema = z.object({
  name: z.string().min(1, "Required").max(120),
});

const businessSchema = z.object({
  name: z.string().min(1, "Required").max(120),
  legal_name: z.string().min(1, "Legal name is required").max(200),
  registration_number: z.string().max(80).optional().or(z.literal("")),
  tax_number: z.string().max(80).optional().or(z.literal("")),
  industry: z.string().max(100).optional().or(z.literal("")),
  website: z
    .string()
    .max(200)
    .refine(
      (v) => !v || v.startsWith("http://") || v.startsWith("https://"),
      "Must start with http:// or https://",
    )
    .optional()
    .or(z.literal("")),
  country: z
    .string()
    .length(2, "Use a 2-letter ISO country code (e.g. ZA, US, GB)")
    .toUpperCase()
    .optional()
    .or(z.literal("")),
});

const inviteSchema = z.object({
  token: z.string().min(1, "Paste your invite token"),
});

// ── Page shell ───────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const [params] = useSearchParams();
  const initialTab = params.get("tab") === "join" ? "join" : "create";
  const [tab, setTab] = useState(initialTab);

  return (
    <div className="min-h-screen bg-ink-50/40 flex flex-col">
      <header className="px-8 py-6">
        <Wordmark />
      </header>
      <main className="flex-1 flex items-center justify-center px-6 pb-12">
        <div className="w-full max-w-lg">
          <div className="text-center mb-10">
            <h2 className="text-display text-ink-900">Set up your workspace</h2>
            <p className="mt-2 text-sm text-ink-500">
              Create a new organization or join one with an invite.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-1 p-1 mb-6 rounded-md bg-ink-100">
            <TabButton
              active={tab === "create"}
              onClick={() => setTab("create")}
              icon={<Building2 size={14} />}
            >
              Create
            </TabButton>
            <TabButton
              active={tab === "join"}
              onClick={() => setTab("join")}
              icon={<Mail size={14} />}
            >
              Join with invite
            </TabButton>
          </div>

          <div className="bg-ink-0 rounded-lg shadow-card p-6">
            {tab === "create" ? <CreateOrgFlow /> : <JoinByInviteForm />}
          </div>
        </div>
      </main>
    </div>
  );
}

function TabButton({ active, onClick, icon, children }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-2 py-2 text-sm font-medium tracking-tight rounded transition-all duration-150",
        active
          ? "bg-ink-0 text-ink-900 shadow-card"
          : "text-ink-500 hover:text-ink-700",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ── Create-org flow: kind → profile → confirmation ───────────────────────────

function CreateOrgFlow() {
  // step: "kind" | "profile" | "done"
  const [step, setStep] = useState("kind");
  const [kind, setKind] = useState(null);
  const [org, setOrg] = useState(null); // created org payload

  if (step === "kind") {
    return (
      <KindChooser
        onChoose={(k) => {
          setKind(k);
          setStep("profile");
        }}
      />
    );
  }

  if (step === "profile") {
    return (
      <ProfileForm
        kind={kind}
        onBack={() => setStep("kind")}
        onSuccess={(createdOrg) => {
          setOrg(createdOrg);
          setStep("done");
        }}
      />
    );
  }

  return <ConfirmationScreen org={org} kind={kind} />;
}

// Step 1: Kind chooser ─────────────────────────────────────────────────────

function KindChooser({ onChoose }) {
  return (
    <div className="space-y-4">
      <div className="mb-6">
        <p className="text-sm font-medium tracking-tight text-ink-900">
          What kind of organization is this?
        </p>
        <p className="mt-1 text-[13px] text-ink-500">
          This choice shapes your categories, reporting, and ledger — it cannot
          be changed later.
        </p>
      </div>

      <KindCard
        icon={<User size={20} />}
        title="Personal"
        description="Track your own spending. Simple categories, no VAT or registration fields."
        onClick={() => onChoose("personal")}
      />

      <KindCard
        icon={<Building2 size={20} />}
        title="Business"
        description="Full business profile with legal name, tax / VAT number, and business-grade categories."
        onClick={() => onChoose("business")}
      />
    </div>
  );
}

function KindCard({ icon, title, description, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left flex items-start gap-4 p-4 rounded-lg border border-ink-200",
        "hover:border-ink-950 hover:bg-ink-50 transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
      )}
    >
      <span className="mt-0.5 flex-shrink-0 p-2 rounded-md bg-ink-100 text-ink-700">
        {icon}
      </span>
      <span>
        <span className="block text-sm font-medium tracking-tight text-ink-900">
          {title}
        </span>
        <span className="mt-0.5 block text-[13px] text-ink-500 leading-snug">
          {description}
        </span>
      </span>
    </button>
  );
}

// Step 2: Profile form ─────────────────────────────────────────────────────

function ProfileForm({ kind, onBack, onSuccess }) {
  const navigate = useNavigate();
  const setActiveOrg = useOrgStore((s) => s.setActiveOrg);
  const create = useCreateOrg();

  const schema = kind === "business" ? businessSchema : personalSchema;

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({ resolver: zodResolver(schema) });

  const onSubmit = (data) => {
    // Strip empty optional strings before sending.
    const clean = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== "" && v !== undefined),
    );
    const payload = { ...clean, kind };

    create.mutate(payload, {
      onSuccess: (org) => {
        setActiveOrg(org.id);
        onSuccess(org);
      },
      onError: (e) => toast.error(e.message || "Could not create organization"),
    });
  };

  return (
    <form className="space-y-5" onSubmit={handleSubmit(onSubmit)}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="text-sm font-medium tracking-tight text-ink-900">
            {kind === "business" ? "Business profile" : "Personal profile"}
          </p>
          <p className="text-[13px] text-ink-500 mt-0.5">
            {kind === "business"
              ? "Required: legal name. Everything else is optional."
              : "Just a name for your personal workspace."}
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="text-[13px] text-ink-500 hover:text-ink-700 underline underline-offset-4"
        >
          Change kind
        </button>
      </div>

      {/* Organization display name — both kinds */}
      <FormField
        label={kind === "business" ? "Organization name" : "Workspace name"}
        hint="How it appears in the app"
        error={errors.name?.message}
        required
      >
        {(id) => (
          <Input
            id={id}
            autoFocus
            placeholder={kind === "business" ? "Acme Inc." : "My Finances"}
            invalid={!!errors.name}
            {...register("name")}
          />
        )}
      </FormField>

      {/* Business-only fields */}
      {kind === "business" && (
        <>
          <FormField
            label="Legal name"
            hint="As it appears on official documents"
            error={errors.legal_name?.message}
            required
          >
            {(id) => (
              <Input
                id={id}
                placeholder="Acme Incorporated (Pty) Ltd"
                invalid={!!errors.legal_name}
                {...register("legal_name")}
              />
            )}
          </FormField>

          <div className="grid grid-cols-2 gap-4">
            <FormField
              label="Registration number"
              error={errors.registration_number?.message}
            >
              {(id) => (
                <Input
                  id={id}
                  placeholder="2024/123456/07"
                  invalid={!!errors.registration_number}
                  {...register("registration_number")}
                />
              )}
            </FormField>

            <FormField
              label="Tax / VAT number"
              error={errors.tax_number?.message}
            >
              {(id) => (
                <Input
                  id={id}
                  placeholder="4012345678"
                  invalid={!!errors.tax_number}
                  {...register("tax_number")}
                />
              )}
            </FormField>
          </div>

          <FormField
            label="Industry"
            hint="e.g. Retail, Hospitality, Consulting"
            error={errors.industry?.message}
          >
            {(id) => (
              <Input
                id={id}
                placeholder="Retail"
                invalid={!!errors.industry}
                {...register("industry")}
              />
            )}
          </FormField>

          <div className="grid grid-cols-2 gap-4">
            <FormField
              label="Website"
              error={errors.website?.message}
            >
              {(id) => (
                <Input
                  id={id}
                  placeholder="https://acme.com"
                  invalid={!!errors.website}
                  {...register("website")}
                />
              )}
            </FormField>

            <FormField
              label="Country"
              hint="2-letter ISO code"
              error={errors.country?.message}
            >
              {(id) => (
                <Input
                  id={id}
                  placeholder="ZA"
                  maxLength={2}
                  className="uppercase"
                  invalid={!!errors.country}
                  {...register("country")}
                />
              )}
            </FormField>
          </div>
        </>
      )}

      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="w-full"
        loading={create.isPending}
      >
        {kind === "business" ? "Create business" : "Create workspace"}
      </Button>
    </form>
  );
}

// Step 3: Confirmation ─────────────────────────────────────────────────────

function ConfirmationScreen({ org, kind }) {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  // Build the inbound email address from org.rx_local_part + RX_DOMAIN.
  const rxLocal = org?.rx_local_part;
  const inboundEmail = rxLocal
    ? RX_DOMAIN
      ? `${rxLocal}@${RX_DOMAIN}`
      : null
    : null;
  const inboundDisplay = rxLocal
    ? RX_DOMAIN
      ? `${rxLocal}@${RX_DOMAIN}`
      : `${rxLocal}@…`
    : null;

  const handleCopy = () => {
    if (!inboundEmail) return;
    navigator.clipboard.writeText(inboundEmail).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="space-y-6">
      {/* Success header */}
      <div className="flex flex-col items-center text-center gap-3 pb-2">
        <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-accent text-ink-950">
          <Check size={24} strokeWidth={2.5} />
        </span>
        <div>
          <h3 className="text-base font-semibold tracking-tight text-ink-900">
            {org?.name ?? "Workspace"} is ready
          </h3>
          <p className="mt-1 text-[13px] text-ink-500">
            Your{" "}
            <span className="font-medium text-ink-700">
              {kind === "business" ? "business" : "personal"}
            </span>{" "}
            workspace has been created.
          </p>
        </div>
      </div>

      {/* Inbound email callout */}
      {inboundDisplay && (
        <div className="rounded-lg border border-ink-200 bg-ink-50 p-4 space-y-2">
          <p className="text-[12px] font-medium uppercase tracking-widest text-ink-400">
            Your inbound address
          </p>
          <div className="flex items-center justify-between gap-3">
            <code className="text-sm font-mono text-ink-900 break-all">
              {inboundDisplay}
            </code>
            {inboundEmail && (
              <button
                type="button"
                onClick={handleCopy}
                title="Copy address"
                className="flex-shrink-0 p-1.5 rounded hover:bg-ink-200 transition-colors text-ink-500 hover:text-ink-900"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            )}
          </div>
          <p className="text-[12px] text-ink-500 leading-snug">
            Forward slips, receipts, and invoices to this address and they will
            appear in your document queue automatically.
            {!RX_DOMAIN && (
              <span className="ml-1 text-ink-400">
                (Configure <code className="text-[11px]">VITE_RX_DOMAIN</code> to see the full address.)
              </span>
            )}
          </p>
        </div>
      )}

      <Button
        variant="primary"
        size="lg"
        className="w-full"
        onClick={() => navigate("/dashboard", { replace: true })}
      >
        Go to dashboard
      </Button>
    </div>
  );
}

// ── Join with invite ──────────────────────────────────────────────────────────

function JoinByInviteForm() {
  const navigate = useNavigate();
  const setActiveOrg = useOrgStore((s) => s.setActiveOrg);
  const accept = useAcceptInvitation();
  const [params] = useSearchParams();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(inviteSchema),
    defaultValues: { token: params.get("token") || "" },
  });

  const onSubmit = (data) => {
    accept.mutate(data.token, {
      onSuccess: (res) => {
        setActiveOrg(res.organization.id);
        toast.success("Welcome to the team");
        navigate("/dashboard", { replace: true });
      },
      onError: (e) => toast.error(e.message),
    });
  };

  return (
    <form className="space-y-5" onSubmit={handleSubmit(onSubmit)}>
      <FormField
        label="Invite token"
        hint="Paste from your invite link"
        error={errors.token?.message}
        required
      >
        {(id) => (
          <Input
            id={id}
            autoFocus
            className="font-mono text-[13px]"
            placeholder="vK3p…"
            invalid={!!errors.token}
            {...register("token")}
          />
        )}
      </FormField>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="w-full"
        loading={accept.isPending}
      >
        Accept invitation
      </Button>
    </form>
  );
}
