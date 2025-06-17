import { NavLink } from 'react-router-dom'
import { BarChart3, Tag, MessageSquare, Home, FileText } from 'lucide-react'
import clsx from 'clsx'

const navItems = [
  { id: 'overview', label: 'Overview', icon: Home, path: '/overview' },
  { id: 'themes', label: 'Themes', icon: BarChart3, path: '/themes' },
  { id: 'summaries', label: 'Theme Summaries', icon: FileText, path: '/summaries' },
  { id: 'entities', label: 'Topics', icon: Tag, path: '/entities' },
  { id: 'comments', label: 'Comments', icon: MessageSquare, path: '/comments' }
]

function Navigation() {
  return (
    <nav className="flex space-x-1 bg-gray-100 p-1 rounded-lg">
      {navItems.map(({ id, label, icon: Icon, path }) => (
        <NavLink
          key={id}
          to={path}
          className={({ isActive }) => clsx(
            'flex-1 flex items-center justify-center space-x-2 py-2.5 px-4 rounded-md transition-all',
            isActive
              ? 'bg-white text-blue-600 shadow-sm'
              : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
          )}
        >
          <Icon className="h-4 w-4" />
          <span className="font-medium">{label}</span>
        </NavLink>
      ))}
    </nav>
  )
}

export default Navigation 