import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Building2, Mail } from "lucide-react";
import { Wordmark } from "@/components/Wordmark";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { FormField } from "@/components/ui/FormField";
import { useAcceptInvitation, useCreateOrg } from "@/lib/queries";
import { useOrgStore } from "@/stores/org";
import { cn } from "@/lib/cn";

const orgSchema = z.object({
  name: z.string().min(1, "Required").max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/, "Lowercase letters, digits, dashes (3-64 chars)"),
});

const inviteSchema = z.object({
  token: z.string().min(1, "Paste your invite token"),
});

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
        <div className="w-full max-w-md">
          <div className="text-center mb-10">
            <h2 className="text-display text-ink-900">Set up your workspace</h2>
            <p className="mt-2 text-sm text-ink-500">
              Create a new organization or join one with an invite.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-1 p-1 mb-6 rounded-md bg-ink-100">
            <TabButton active={tab === "create"} onClick={() => setTab("create")} icon={<Building2 size={14} />}>
              Create
            </TabButton>
            <TabButton active={tab === "join"} onClick={() => setTab("join")} icon={<Mail size={14} />}>
              Join with invite
            </TabButton>
          </div>

          <div className="bg-ink-0 rounded-lg shadow-card p-6">
            {tab === "create" ? <CreateOrgForm /> : <JoinByInviteForm />}
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
        active ? "bg-ink-0 text-ink-900 shadow-card" : "text-ink-500 hover:text-ink-700",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function CreateOrgForm() {
  const navigate = useNavigate();
  const setActiveOrg = useOrgStore((s) => s.setActiveOrg);
  const create = useCreateOrg();
  const { register, handleSubmit, formState: { errors }, watch, setValue } = useForm({
    resolver: zodResolver(orgSchema),
  });

  // Auto-suggest slug from name on first focus.
  const name = watch("name");
  const onNameBlur = () => {
    if (!watch("slug") && name) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 62);
      setValue("slug", slug);
    }
  };

  const onSubmit = (data) => {
    create.mutate(data, {
      onSuccess: (org) => {
        setActiveOrg(org.id);
        toast.success(`${org.name} created`);
        navigate("/dashboard", { replace: true });
      },
      onError: (e) => toast.error(e.message),
    });
  };

  return (
    <form className="space-y-5" onSubmit={handleSubmit(onSubmit)}>
      <FormField label="Organization name" error={errors.name?.message} required>
        {(id) => (
          <Input id={id} autoFocus placeholder="Acme Inc." onBlurCapture={onNameBlur} invalid={!!errors.name} {...register("name")} />
        )}
      </FormField>
      <FormField label="URL slug" hint="Used in URLs and exports" error={errors.slug?.message} required>
        {(id) => (
          <div className="flex items-stretch">
            <span className="inline-flex items-center px-3 rounded-l-md border border-r-0 border-ink-200 bg-ink-50 text-sm text-ink-500 tracking-tight">
              slip/scan/
            </span>
            <Input id={id} className="rounded-l-none" placeholder="acme" invalid={!!errors.slug} {...register("slug")} />
          </div>
        )}
      </FormField>
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={create.isPending}>
        Create organization
      </Button>
    </form>
  );
}

function JoinByInviteForm() {
  const navigate = useNavigate();
  const setActiveOrg = useOrgStore((s) => s.setActiveOrg);
  const accept = useAcceptInvitation();
  const [params] = useSearchParams();
  const { register, handleSubmit, formState: { errors } } = useForm({
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
      <FormField label="Invite token" hint="Paste from your invite link" error={errors.token?.message} required>
        {(id) => (
          <Input id={id} autoFocus className="font-mono text-[13px]" placeholder="vK3p…" invalid={!!errors.token} {...register("token")} />
        )}
      </FormField>
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={accept.isPending}>
        Accept invitation
      </Button>
    </form>
  );
}
