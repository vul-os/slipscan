import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { FormField } from "@/components/ui/FormField";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

const schema = z.object({
  full_name: z.string().min(1, "Name is required"),
  email: z.string().email("Enter a valid email"),
  password: z.string().min(8, "Use at least 8 characters"),
});

export default function RegisterPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const setSession = useAuthStore((s) => s.setSession);
  const { register, handleSubmit, formState: { errors } } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { email: params.get("email") || "" },
  });

  const mutation = useMutation({
    mutationFn: api.register,
    onSuccess: (data) => {
      setSession(data.user, data.tokens);
      navigate("/onboarding", { replace: true });
    },
    onError: (e) => toast.error(e.message || "Could not create account"),
  });

  return (
    <div>
      <div className="mb-10">
        <h2 className="text-display text-ink-900">Create your account</h2>
        <p className="mt-2 text-sm text-ink-500">
          Free forever during early access. No card needed.
        </p>
      </div>

      <form className="space-y-5" onSubmit={handleSubmit((d) => mutation.mutate(d))}>
        <FormField label="Full name" error={errors.full_name?.message} required>
          {(id) => (
            <Input id={id} autoFocus placeholder="Jane Doe" invalid={!!errors.full_name} {...register("full_name")} />
          )}
        </FormField>

        <FormField label="Work email" error={errors.email?.message} required>
          {(id) => (
            <Input id={id} type="email" autoComplete="email" placeholder="you@company.com" invalid={!!errors.email} {...register("email")} />
          )}
        </FormField>

        <FormField label="Password" hint="At least 8 characters" error={errors.password?.message} required>
          {(id) => (
            <Input id={id} type="password" autoComplete="new-password" placeholder="••••••••" invalid={!!errors.password} {...register("password")} />
          )}
        </FormField>

        <Button type="submit" variant="primary" size="lg" className="w-full" loading={mutation.isPending}>
          Create account
        </Button>
      </form>

      <p className="mt-8 text-sm text-ink-500">
        Already have an account?{" "}
        <Link to="/login" className="text-ink-900 underline underline-offset-4 decoration-ink-300 hover:decoration-ink-700">
          Sign in
        </Link>
      </p>
    </div>
  );
}
