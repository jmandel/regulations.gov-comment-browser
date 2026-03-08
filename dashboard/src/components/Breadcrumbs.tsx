import { Link } from 'react-router-dom'
import { ChevronRight, Home } from 'lucide-react'

interface BreadcrumbItem {
  label: string
  path?: string
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[]
}

function Breadcrumbs({ items }: BreadcrumbsProps) {
  return (
    <nav className="flex items-center text-sm text-gray-600 mb-4 overflow-x-auto pb-1">
      <Link to="/" className="hover:text-gray-900 flex items-center flex-shrink-0">
        <Home className="h-4 w-4" />
      </Link>
      {items.map((item, index) => (
        <div key={index} className="flex items-center min-w-0">
          <ChevronRight className="h-4 w-4 mx-1 text-gray-400 flex-shrink-0" />
          {item.path ? (
            <Link to={item.path} className="hover:text-gray-900 truncate max-w-[120px] sm:max-w-[200px] md:max-w-none">
              {item.label}
            </Link>
          ) : (
            <span className="text-gray-900 font-medium truncate max-w-[150px] sm:max-w-[250px] md:max-w-none">{item.label}</span>
          )}
        </div>
      ))}
    </nav>
  )
}

export default Breadcrumbs 
