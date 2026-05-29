import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { FormField } from "@/components/ui/FormField";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email) return;
    setPending(true);
    try {
      // No endpoint yet — show the success toast regardless so we don't
      // leak whether an address is registered.
      toast.success("If that email is on file, a reset link is on its way.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <div className="mb-10">
        <h2 className="text-display text-ink-900">Reset your password</h2>
        <p className="mt-2 text-sm text-ink-500">
          Enter your email and we&apos;ll send you a reset link.
        </p>
      </div>

      <form className="space-y-5" onSubmit={handleSubmit}>
        <FormField label="Email" required>
          {(id) => (
            <Input
              id={id}
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </FormField>

        <Button type="submit" variant="primary" size="lg" className="w-full" loading={pending}>
          Send reset link
        </Button>
      </form>

      <p className="mt-8 text-sm text-ink-500">
        Remembered it?{" "}
        <Link
          to="/login"
          className="text-ink-900 underline underline-offset-4 decoration-ink-300 hover:decoration-ink-700"
        >
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
