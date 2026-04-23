import { redirect } from 'next/navigation'

// Root route — redirect to infrastructure as the default dashboard
export default function RootPage() {
  redirect('/infrastructure')
}
