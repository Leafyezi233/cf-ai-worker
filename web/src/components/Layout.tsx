import { useState, useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { api } from "../api/client";
import { BrandLockup, Button } from "./ui";
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
    title: "总览",
    items: [
      { to: "/dashboard", label: "仪表盘", icon: IconDashboard },
      { to: "/usage", label: "用量与账单", icon: IconUsage },
    ],
  },
  {
    title: "用户",
    items: [
      { to: "/devices", label: "用户账户", icon: IconDevices },
      { to: "/monthly-passes", label: "月卡", icon: IconFileText },
      { to: "/device-templates", label: "账户模板", icon: IconFileText },
    ],
  },
  {
    title: "模型与价格",
    items: [
      { to: "/providers", label: "上游接口", icon: IconProviders },
      { to: "/models", label: "模型", icon: IconModels },
      { to: "/model-groups", label: "模型池", icon: IconDatabase },
      { to: "/service-groups", label: "服务分组", icon: IconDatabase },
      { to: "/peak-pricing", label: "峰谷定价", icon: IconZap },
      { to: "/playground", label: "在线测试", icon: IconPlayground },
    ],
  },
  {
    title: "运营",
    items: [
      { to: "/video-tasks", label: "视频任务", icon: IconFileText },
      { to: "/audit", label: "审计日志", icon: IconFileText },
    ],
  },
  {
    title: "系统",
    items: [{ to: "/settings", label: "系统设置", icon: IconSettings }],
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

  const currentTitle = navItems.find((n) => n.to === location.pathname)?.label || "管理后台";
  const currentSectionTitle = currentSection(location.pathname);

  const renderNavList = () => (
    <nav className="p-3 space-y-5 overflow-y-auto">
      {navSections.map((section) => (
        <div key={section.title} className="space-y-0.5">
          <div className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-slate-400 dark:text-slate-500 select-none">
            {section.title}
          </div>
          {section.items.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300 font-semibold"
                      : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100/70 dark:hover:bg-slate-800/60"
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon className={`w-4 h-4 shrink-0 ${isActive ? "text-brand-600 dark:text-brand-300" : "text-slate-400 dark:text-slate-500"}`} />
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
    <div className="flex min-h-screen bg-slate-50 dark:bg-slate-950">
      { }
      <aside className="hidden md:flex w-64 shrink-0 h-screen sticky top-0 border-r border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 flex-col justify-between select-none overflow-y-auto z-20">
        <div className="flex flex-col min-h-0">
          { }
          <div className="h-16 px-5 flex items-center border-b border-slate-100 dark:border-slate-800 shrink-0">
            <BrandLockup subtitle="管理后台" />
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
              {isHealthy ? "网关在线" : "网关无响应"}
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
                <BrandLockup subtitle="管理后台" />
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
                  {isHealthy ? "网关在线" : "网关无响应"}
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
              className="md:hidden p-1.5 -ml-1.5 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500/20"
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
        <main className="flex-1 p-4 sm:p-6 lg:p-8 w-full max-w-[1600px] mx-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

