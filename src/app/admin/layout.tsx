import { Shell } from '../shell/Shell';

/** The admin console is wrapped in the app shell: sidebar, org name and sign-out. */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <Shell>{children}</Shell>;
}
