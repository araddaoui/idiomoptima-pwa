import { ClerkProvider, SignIn, SignUp, useUser } from "@clerk/clerk-react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import LandingPage from "./pages/LandingPage";
import ToolPage from "./pages/ToolPage";

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || "";

const clerkAppearance = {
  baseTheme: undefined,
  variables: {
    colorPrimary: "#6366f1",
    colorBackground: "#111827",
    colorText: "#e2e8f0",
    colorInputBackground: "rgba(255,255,255,0.05)",
    colorInputText: "#e2e8f0",
    borderRadius: "0.75rem",
  },
  elements: {
    formButtonPrimary: "bg-gradient-to-r from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600",
    card: "bg-[#111827] border border-white/10 shadow-2xl",
    headerTitle: "text-white",
    headerSubtitle: "text-slate-400",
    formFieldLabel: "text-slate-400",
    formFieldInput: "bg-white/5 border-white/10 text-white",
    footerActionLink: "text-indigo-400 hover:text-indigo-300",
    socialButtonsBlockButton: "bg-white/5 border-white/10 text-white hover:bg-white/10",
    dividerLine: "bg-white/10",
    dividerText: "text-slate-500",
  },
};

function LandingRoute() {
  const navigate = useNavigate();
  const { isSignedIn } = useUser();
  return (
    <LandingPage
      onStartFree={() => navigate(isSignedIn ? "/app" : "/sign-up")}
      onGoToApp={() => navigate("/app")}
    />
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useUser();
  if (!isLoaded) {
    return (
      <div className="min-h-screen bg-[#0A192F] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-blue-500/30 border-t-blue-400 rounded-full animate-spin" />
      </div>
    );
  }
  if (!isSignedIn) return <Navigate to="/sign-in" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <ClerkProvider publishableKey={CLERK_KEY}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingRoute />} />
          <Route
            path="/sign-in/*"
            element={
              <div className="min-h-screen bg-[#0B1120] flex items-center justify-center px-4">
                <SignIn routing="path" path="/sign-in" appearance={clerkAppearance} />
              </div>
            }
          />
          <Route
            path="/sign-up/*"
            element={
              <div className="min-h-screen bg-[#0B1120] flex items-center justify-center px-4">
                <SignUp routing="path" path="/sign-up" appearance={clerkAppearance} />
              </div>
            }
          />
          <Route
            path="/app"
            element={
              <ProtectedRoute>
                <ToolPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ClerkProvider>
  );
}
