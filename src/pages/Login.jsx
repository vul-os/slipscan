import { Link, useNavigate, useLocation } from "react-router-dom";
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
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const setSession = useAuthStore((s) => s.setSession);
  const { register, handleSubmit, formState: { errors } } = useForm({
    resolver: zodResolver(schema),
  });

  const mutation = useMutation({
    mutationFn: api.login,
    onSuccess: (data) => {
      setSession(data.user, data.tokens);
      const redirect = location.state?.from || "/dashboard";
      navigate(redirect, { replace: true });
    },
    onError: (e) => {
      toast.error(e.message || "Sign in failed");
    },
  });

  return (
    <div>
      <div className="mb-10">
        <h2 className="text-display text-ink-900">Welcome back</h2>
        <p className="mt-2 text-sm text-ink-500">
          Sign in to your account to keep track of receipts.
        </p>
      </div>

      <form className="space-y-5" onSubmit={handleSubmit((d) => mutation.mutate(d))}>
        <FormField label="Email" error={errors.email?.message} required>
          {(id) => (
            <Input
              id={id}
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="you@company.com"
              invalid={!!errors.email}
              {...register("email")}
            />
          )}
        </FormField>

        <FormField label="Password" error={errors.password?.message} required>
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              invalid={!!errors.password}
              {...register("password")}
            />
          )}
        </FormField>

        <Button type="submit" variant="primary" size="lg" className="w-full" loading={mutation.isPending}>
          Sign in
        </Button>
      </form>

      <p className="mt-8 text-sm text-ink-500">
        New here?{" "}
        <Link to="/register" className="text-ink-900 underline underline-offset-4 decoration-ink-300 hover:decoration-ink-700">
          Create an account
        </Link>
      </p>
    </div>
  );
}
