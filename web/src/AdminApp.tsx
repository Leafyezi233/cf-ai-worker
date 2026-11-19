import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { ThemeProvider } from "./hooks/useTheme";
import { ToastProvider } from "./components/Toast";
const Layout = lazy(() => import("./components/Layout"));
import LoginPage from "./pages/LoginPage";
import { Spinner } from "./components/ui";
import { AdminLoadBoundary } from "./components/AdminLoadBoundary";

const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const ProvidersPage = lazy(() => import("./pages/ProvidersPage"));
const ModelsPage = lazy(() => import("./pages/ModelsPage"));
const PlaygroundPage = lazy(() => import("./pages/PlaygroundPage"));
const DevicesPage = lazy(() => import("./pages/DevicesPage"));
const UsagePage = lazy(() => import("./pages/UsagePage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const PeakPricingPage = lazy(() => import("./pages/PeakPricingPage"));
const ModelGroupsPage = lazy(() => import("./pages/ModelGroupsPage"));
const ServiceGroupsPage = lazy(() => import("./pages/ServiceGroupsPage"));
const DeviceTemplatesPage = lazy(() => import("./pages/DeviceTemplatesPage"));
const MonthlyPassesPage = lazy(() => import("./pages/MonthlyPassesPage"));

function PageLoader() {
  return (
    <div className="flex items-center justify-center p-12 min-h-[400px]">
      <Spinner text="正在加载页面…" />
    </div>
  );
}

function Protected() {
  const { loading, authenticated } = useAuth();
  if (loading) return <PageLoader />;
  if (!authenticated) return <Navigate to="/login" replace />;
  return <Layout />;
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <AdminLoadBoundary><Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route element={<Protected />}>
                { 

}
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/providers" element={<ProvidersPage />} />
                <Route path="/models" element={<ModelsPage />} />
                <Route path="/model-groups" element={<ModelGroupsPage />} />
                <Route path="/service-groups" element={<ServiceGroupsPage />} />
                <Route path="/peak-pricing" element={<PeakPricingPage />} />
                <Route path="/playground" element={<PlaygroundPage />} />
                <Route path="/devices" element={<DevicesPage />} />
                <Route path="/device-templates" element={<DeviceTemplatesPage />} />
                <Route path="/monthly-passes" element={<MonthlyPassesPage />} />
                <Route path="/usage" element={<UsagePage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense></AdminLoadBoundary>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}