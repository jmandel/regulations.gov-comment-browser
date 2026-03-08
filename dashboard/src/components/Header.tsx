import { FileText } from 'lucide-react'
import useStore from '../store/useStore'

function Header() {
  const { meta } = useStore()

  return (
    <header className="bg-white shadow-sm border-b">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center py-3 sm:py-4">
          <div className="flex items-center space-x-3 min-w-0">
            <FileText className="h-7 w-7 sm:h-8 sm:w-8 text-blue-600 flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900 truncate">Comment Analysis Dashboard</h1>
              <p className="text-sm text-gray-500 truncate">
                Document: {meta?.documentId || 'Loading...'}
                {meta?.stats && (
                  <span className="ml-2">
                    • {meta.stats.totalComments.toLocaleString()} comments
                  </span>
                )}
              </p>
            </div>
          </div>
        </div>
      </div>
    </header>
  )
}

export default Header 
