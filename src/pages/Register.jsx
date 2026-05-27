// P2-01: Registration — collects credentials only.
// Org kind + profile are captured in the subsequent /onboarding step.

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

const GOOGLE_AUTH_URL = `${import.meta.env.VITE_API_URL}/auth/google`;

const schema = z.object({
  full_name: z.string().min(1, "Name is required").max(200),
  email: z.string().email("Enter a valid email"),
  password: z
    .string()
    .min(8, "Use at least 8 characters")
    .max(128, "Password is too long"),
});

export default function RegisterPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const setSession = useAuthStore((s) => s.setSession);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { email: params.get("email") || "" },
  });

  const mutation = useMutation({
    mutationFn: api.register,
    onSuccess: (data) => {
      setSession(data.user, data.tokens);
      // Kind chooser + org profile live in /onboarding.
      navigate("/onboarding", { replace: true });
    },
    onError: (e) => toast.error(e.message || "Could not create account"),
  });

  return (
    <div>
      <div className="mb-10">
        <h2 className="text-display text-ink-900">Create your account</h2>
        <p className="mt-2 text-sm text-ink-500">
          Free during early access — no card needed. You will set up your
          organization on the next step.
        </p>
      </div>

      <form
        className="space-y-5"
        onSubmit={handleSubmit((d) => mutation.mutate(d))}
      >
        <FormField label="Full name" error={errors.full_name?.message} required>
          {(id) => (
            <Input
              id={id}
              autoFocus
              autoComplete="name"
              placeholder="Jane Doe"
              invalid={!!errors.full_name}
              {...register("full_name")}
            />
          )}
        </FormField>

        <FormField label="Email" error={errors.email?.message} required>
          {(id) => (
            <Input
              id={id}
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              invalid={!!errors.email}
              {...register("email")}
            />
          )}
        </FormField>

        <FormField
          label="Password"
          hint="At least 8 characters"
          error={errors.password?.message}
          required
        >
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              invalid={!!errors.password}
              {...register("password")}
            />
          )}
        </FormField>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full"
          loading={mutation.isPending}
        >
          Create account
        </Button>
      </form>

      <div className="relative my-6 flex items-center">
        <div className="flex-1 border-t border-ink-200" />
        <span className="mx-3 text-xs text-ink-400 select-none">or</span>
        <div className="flex-1 border-t border-ink-200" />
      </div>

      <Button
        variant="secondary"
        size="lg"
        className="w-full"
        onClick={() => { window.location.href = GOOGLE_AUTH_URL; }}
      >
        <GoogleIcon />
        Continue with Google
      </Button>

      <p className="mt-8 text-sm text-ink-500">
        Already have an account?{" "}
        <Link
          to="/login"
          className="text-ink-900 underline underline-offset-4 decoration-ink-300 hover:decoration-ink-700"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4" />
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853" />
      <path d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332Z" fill="#FBBC05" />
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.163 6.656 3.58 9 3.58Z" fill="#EA4335" />
    </svg>
  );
}
