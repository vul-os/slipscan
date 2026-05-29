import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import AuthLayout from "@/layouts/AuthLayout";
import AppLayout from "@/layouts/AppLayout";
import { Skeleton } from "@/components/ui/Skeleton";

const LandingPage = lazy(() => import("@/pages/Landing"));
const LoginPage = lazy(() => import("@/pages/Login"));
const RegisterPage = lazy(() => import("@/pages/Register"));
const ForgotPasswordPage = lazy(() => import("@/pages/ForgotPassword"));
const OnboardingPage = lazy(() => import("@/pages/Onboarding"));
const AcceptInvitePage = lazy(() => import("@/pages/AcceptInvite"));
const DashboardPage = lazy(() => import("@/pages/Dashboard"));
const ReceiptsPage = lazy(() => import("@/pages/Receipts"));
const ReceiptDetailPage = lazy(() => import("@/pages/ReceiptDetail"));
const AskPage = lazy(() => import("@/pages/Ask"));
const MembersPage = lazy(() => import("@/pages/Members"));
const SettingsPage = lazy(() => import("@/pages/Settings"));
const BudgetsPage = lazy(() => import("@/pages/Budgets"));
const NetWorthPage = lazy(() => import("@/pages/NetWorth"));
const LedgerPage = lazy(() => import("@/pages/Ledger"));
const ReportsPage = lazy(() => import("@/pages/Reports"));
const AuditPage = lazy(() => import("@/pages/Audit"));
const BankFeedsPage = lazy(() => import("@/pages/BankFeeds"));
const ReconcilePage = lazy(() => import("@/pages/Reconcile"));
const WorkspacePage = lazy(() => import("@/pages/Workspace"));
const InsightsPage = lazy(() => import("@/pages/Insights"));
const AuthCallbackPage = lazy(() => import("@/pages/AuthCallback"));
const NotFoundPage = lazy(() => import("@/pages/NotFound"));
const BrandPreviewPage = lazy(() => import("@/pages/BrandPreview"));

// Docs — public, outside AppLayout
const DocsLayout = lazy(() => import("@/components/docs/DocsLayout"));
const DocsIndex = lazy(() => import("@/pages/docs/DocsIndex"));
const Quickstart = lazy(() => import("@/pages/docs/Quickstart"));
const Concepts = lazy(() => import("@/pages/docs/Concepts"));
const FeaturesIndex = lazy(() => import("@/pages/docs/FeaturesIndex"));
const IntegrationsIndex = lazy(() => import("@/pages/docs/IntegrationsIndex"));
const FaqDocs = lazy(() => import("@/pages/docs/Faq"));
const Security = lazy(() => import("@/pages/docs/Security"));
const Changelog = lazy(() => import("@/pages/docs/Changelog"));

function PageFallback() {
  return (
    <div className="p-10 space-y-3">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-4 w-96" />
      <Skeleton className="h-64 mt-6" />
    </div>
  );
}

export function AppRoutes() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/" element={<LandingPage />} />

        {/* Public auth routes */}
        <Route element={<AuthLayout />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        </Route>

        {/* OAuth callback — must be public (user is not yet in the store) */}
        <Route path="/auth/callback" element={<AuthCallbackPage />} />

        {/* Authenticated, but no app shell */}
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/invitations/accept" element={<AcceptInvitePage />} />

        {/* Authenticated app */}
        <Route element={<AppLayout />}>
          <Route path="/dashboard"           element={<DashboardPage />} />
          <Route path="/receipts"            element={<ReceiptsPage />} />
          <Route path="/receipts/:id"        element={<ReceiptDetailPage />} />
          <Route path="/ask"                 element={<AskPage />} />
          <Route path="/budgets"             element={<BudgetsPage />} />
          <Route path="/net-worth"           element={<NetWorthPage />} />
          <Route path="/ledger"              element={<LedgerPage />} />
          <Route path="/reports"             element={<ReportsPage />} />
          <Route path="/bank-feeds"          element={<BankFeedsPage />} />
          <Route path="/reconcile"           element={<ReconcilePage />} />
          <Route path="/workspace"           element={<WorkspacePage />} />
          <Route path="/insights"            element={<InsightsPage />} />
          <Route path="/audit"               element={<AuditPage />} />
          <Route path="/members"             element={<MembersPage />} />
          <Route path="/settings"            element={<SettingsPage />} />
        </Route>

        {/* Public docs site — outside AppLayout, no auth required */}
        <Route path="/docs" element={<DocsLayout />}>
          <Route index                element={<DocsIndex />} />
          <Route path="quickstart"    element={<Quickstart />} />
          <Route path="concepts"      element={<Concepts />} />
          <Route path="features"      element={<FeaturesIndex />} />
          <Route path="integrations"  element={<IntegrationsIndex />} />
          <Route path="faq"           element={<FaqDocs />} />
          <Route path="security"      element={<Security />} />
          <Route path="changelog"     element={<Changelog />} />
        </Route>

        {/* Internal — brand mark preview, not linked anywhere */}
        <Route path="/_brand" element={<BrandPreviewPage />} />

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
