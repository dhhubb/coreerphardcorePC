import { Shell } from '../shell/Shell';

/** The till is wrapped in the app shell so an operator can move between POS and the console. */
export default function PosLayout({ children }: { children: React.ReactNode }) {
  return <Shell>{children}</Shell>;
}
