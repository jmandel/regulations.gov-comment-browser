import { Outlet } from 'react-router-dom'
import Header from './Header'
import Navigation from './Navigation'

function Layout() {
  return (
    <div className="min-h-screen bg-gray-50 overflow-x-hidden">
      <Header />
      
      <div className="max-w-7xl mx-auto px-2 sm:px-6 lg:px-8 py-4 sm:py-6">
        <Navigation />
        
        <main className="mt-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export default Layout 