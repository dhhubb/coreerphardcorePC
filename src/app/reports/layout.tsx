import { Shell } from '../shell/Shell';

/** The reports console is wrapped in the app shell so its pages carry the role-based menu (F10). */
export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return <Shell>{children}</Shell>;
}
