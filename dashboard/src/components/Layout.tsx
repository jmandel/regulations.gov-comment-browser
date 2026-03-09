import { Outlet } from 'react-router-dom'
import Header from './Header'
import Navigation from './Navigation'

function Layout() {
  return (
    <div className="min-h-screen bg-gray-50 overflow-x-hidden flex flex-col">
      <Header />

      <div className="max-w-7xl mx-auto px-2 sm:px-6 lg:px-8 py-4 sm:py-6 flex-1 w-full">
        <Navigation />

        <main className="mt-6">
          <Outlet />
        </main>
      </div>

      <footer className="border-t border-gray-200 bg-white mt-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex justify-between items-center text-xs text-gray-400">
          <span>AI-powered analysis of public comments</span>
          <a href="../../skill/SKILL.md" className="hover:text-gray-600 transition-colors">
            AI Skill
          </a>
        </div>
      </footer>
    </div>
  )
}

export default Layout 