import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "./hooks/useTheme";
import { ToastProvider } from "./components/Toast";
const ConsolePage = lazy(() => import("./pages/ConsolePage"));

export default function App() {
  return <ThemeProvider><ToastProvider><Suspense fallback={null}>
    <Routes>
      <Route path="/console" element={<ConsolePage />} />
      <Route path="/" element={<Navigate to="/console" replace />} />
      <Route path="*" element={<div>Not Found</div>} />
    </Routes>
  </Suspense></ToastProvider></ThemeProvider>;
}
