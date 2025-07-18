import { Loader2 } from 'lucide-react'

function LoadingScreen() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        <Loader2 className="h-12 w-12 animate-spin text-blue-600 mx-auto" />
        <p className="mt-4 text-gray-600">Loading comment analysis data...</p>
      </div>
    </div>
  )
}

export default LoadingScreen 