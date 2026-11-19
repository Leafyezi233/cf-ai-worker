import { Component, type ReactNode } from "react";
import { adminBase } from "../api/adminPath";

export class AdminLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="p-12 text-center" role="alert">
      <h1>管理页面未能加载</h1>
      <p>登录可能已失效，或页面资源暂时不可用。请重新验证登录后重试。</p>
      <a className="underline" href={adminBase() + "/login"}>重新验证登录</a>
    </main>;
  }
}
