import { useState, useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { api } from "../api/client";
import { Button } from "./ui";
import { ThemeToggle } from "./ThemeToggle";
import { useToast } from "./Toast";
import {
  IconDashboard,
  IconProviders,
  IconModels,
  IconDevices,
  IconDatabase,
  IconUsage,
  IconPlayground,
  IconSettings,
  IconLogOut,
  IconZap,
  IconMenu,
  IconClose,
  IconFileText,
} from "./icons";

const navSections: { title: string; items: { to: string; label: string; icon: typeof IconDashboard }[] }[] = [
  {
    title: "概览",
    items: [
      { to: "/dashboard", label: "仪表盘", icon: IconDashboard },
      { to: "/usage", label: "用量记录", icon: IconUsage },
    ],
  },
  {
    title: "网关配置",
    items: [
      { to: "/providers", label: "Providers", icon: IconProviders },
      { to: "/models", label: "Models", icon: IconModels },
      { to: "/model-groups", label: "模型分组", icon: IconDatabase },
      { to: "/service-groups", label: "服务分组", icon: IconDatabase },
      { to: "/peak-pricing", label: "峰谷定价", icon: IconZap },
    ],
  },
  {
    title: "设备",
    items: [
      { to: "/devices", label: "设备 Token", icon: IconDevices },
      { to: "/device-templates", label: "设备模板", icon: IconFileText },
      { to: "/monthly-passes", label: "月卡管理", icon: IconFileText },
    ],
  },
  {
    title: "其他",
    items: [
      { to: "/playground", label: "Playground", icon: IconPlayground },
      { to: "/settings", label: "系统设置", icon: IconSettings },
    ],
  },
];

const navItems = navSections.flatMap((s) => s.items);

const currentSection = (pathname: string) =>
  navSections.find((s) => s.items.some((i) => i.to === pathname))?.title;

export default function Layout() {
  const { logout } = useAuth();
  const toast = useToast();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isHealthy, setIsHealthy] = useState<boolean | null>(true);

  useEffect(() => {
    let mounted = true;
    const check = () => {
      api
        .get<{ ok: boolean }>("/api/health")
        .then(() => mounted && setIsHealthy(true))
        .catch(() => mounted && setIsHealthy(false));
    };
    check();
    const interval = setInterval(check, 60_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileMenuOpen]);

  const currentTitle = navItems.find((n) => n.to === location.pathname)?.label || "AI Gateway";
  const currentSectionTitle = currentSection(location.pathname);

  const renderNavList = () => (
    <nav className="p-3 space-y-4 overflow-y-auto">
      {navSections.map((section) => (
        <div key={section.title} className="space-y-1">
          <div className="px-3.5 pt-1 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-600 select-none">
            {section.title}
          </div>
          {section.items.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    isActive
                      ? "bg-blue-50/80 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400 shadow-sm shadow-blue-500/5 font-semibold"
                      : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/60"
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon className={`w-4 h-4 shrink-0 ${isActive ? "text-blue-600 dark:text-blue-400" : "text-slate-400 dark:text-slate-500"}`} />
                    <span>{item.label}</span>
                  </>
                )}
              </NavLink>
            );
          })}
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-screen bg-slate-50/50 dark:bg-slate-950">
      { }
      <aside className="hidden md:flex w-64 shrink-0 h-screen sticky top-0 border-r border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 flex-col justify-between select-none overflow-y-auto z-20">
        <div className="flex flex-col min-h-0">
          { }
          <div className="px-6 py-5 flex items-center gap-3 border-b border-slate-100 dark:border-slate-800 shrink-0">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white shadow-md shadow-blue-500/20 shrink-0">
              <IconZap className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="font-bold text-slate-900 dark:text-slate-100 leading-tight text-sm tracking-tight">AI Gateway</div>
              <div className="text-[11px] text-slate-400 dark:text-slate-500 font-medium">Personal Cloudflare API</div>
            </div>
          </div>

          { }
          {renderNavList()}
        </div>

        { }
        <div className="p-4 border-t border-slate-100 dark:border-slate-800 shrink-0">
          <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 text-xs text-slate-500 dark:text-slate-400">
            <span className="flex items-center gap-1.5 font-medium">
              <span
                className={`w-2 h-2 rounded-full ${
                  isHealthy ? "bg-emerald-500 animate-pulse" : "bg-rose-500"
                }`}
              />
              {isHealthy ? "Gateway 在线" : "Gateway 异常"}
            </span>
            <span className="text-[10px] text-slate-400 dark:text-slate-500">v1.0</span>
          </div>
        </div>
      </aside>

      { }
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="fixed inset-0 bg-slate-900/60 dark:bg-slate-950/80 backdrop-blur-sm transition-opacity"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col justify-between shadow-2xl select-none animate-in slide-in-from-left duration-200">
            <div className="flex flex-col min-h-0">
              { }
              <div className="px-5 py-4 flex items-center justify-between border-b border-slate-100 dark:border-slate-800 shrink-0">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white shadow-md shadow-blue-500/20 shrink-0">
                    <IconZap className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <div className="font-bold text-slate-900 dark:text-slate-100 leading-tight text-sm tracking-tight">AI Gateway</div>
                    <div className="text-[10px] text-slate-400 dark:text-slate-500 font-medium">Personal Cloudflare API</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  aria-label="关闭导航菜单"
                >
                  <IconClose className="w-5 h-5" />
                </button>
              </div>

              { }
              {renderNavList()}
            </div>

            { }
            <div className="p-4 border-t border-slate-100 dark:border-slate-800 shrink-0 space-y-3">
              <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 text-xs text-slate-500 dark:text-slate-400">
                <span className="flex items-center gap-1.5 font-medium">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      isHealthy ? "bg-emerald-500 animate-pulse" : "bg-rose-500"
                    }`}
                  />
                  {isHealthy ? "Gateway 在线" : "Gateway 异常"}
                </span>
                <span className="text-[10px] text-slate-400 dark:text-slate-500">v1.0</span>
              </div>
            </div>
          </aside>
        </div>
      )}

      { }
      <div className="flex-1 flex flex-col min-w-0 min-h-screen">
        { }
        <header className="h-14 sm:h-16 flex items-center justify-between border-b border-slate-200/80 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md px-4 sm:px-6 sticky top-0 z-30">
          <div className="flex items-center gap-3">
            { }
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="md:hidden p-1.5 -ml-1.5 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              aria-label="打开导航菜单"
            >
              <IconMenu className="w-5 h-5" />
            </button>
            <h1 className="text-sm sm:text-base font-semibold text-slate-800 dark:text-slate-100 tracking-tight">
              {currentSectionTitle && (
                <span className="hidden sm:inline font-normal text-slate-400 dark:text-slate-500">{currentSectionTitle} <span className="mx-1">/</span> </span>
              )}
              {currentTitle}
            </h1>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <ThemeToggle />
            <div className="h-4 w-px bg-slate-200 dark:bg-slate-700" />
            <Button variant="ghost" size="sm" onClick={() => { void logout().catch(() => toast.error("退出失败，会话尚未撤销，请重试")); }} title="退出登录">
              <IconLogOut className="w-4 h-4 text-slate-500 dark:text-slate-400" />
              <span className="hidden sm:inline">退出登录</span>
            </Button>
          </div>
        </header>

        { }
        <main className="flex-1 p-4 sm:p-6 w-full animate-in fade-in duration-200">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

