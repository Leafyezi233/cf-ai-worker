import AdminVideoTasks from "../components/AdminVideoTasks";

export default function VideoTasksPage() {
  return (
    <div className="space-y-4 sm:space-y-6">
      <div>
        <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">视频任务</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">默认列出需要人工核对的任务（结果未知或长时间等待）。这里只查看，不会重新提交或扣费。</p>
      </div>
      <AdminVideoTasks />
    </div>
  );
}
